//! 通过 Tauri WebView 网络栈提供受 MaterialId 授权的二进制范围响应。
//!
//! 前端永远不会提交托管文件路径。协议查询只包含 MaterialId、offset 和
//! length；Rust 先验证材料处于活跃 ready 状态，再由 ImportRepository 解析
//! 私有托管路径并执行统一的 8 MiB/半开范围校验。

use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::db::import::ImportRepository;
use crate::db::DatabaseHandle;
use crate::error::AppError;
use crate::fs::LibraryPaths;

/// WebView 访问的 custom URI scheme，对应 `http://managed-range.localhost/`。
pub const SCHEME: &str = "managed-range";

struct ManagedRangeQuery {
    material_id: String,
    offset: u64,
    length: u64,
}

/// 解析 `?materialId=...&offset=...&length=...`。
///
/// 查询使用半开范围，协议不接受路径、文件名或其它未定义参数；重复字段
/// 和无法解析的数字均拒绝，避免浏览器或调用方对请求语义产生歧义。
fn parse_query(query: Option<&str>) -> Option<ManagedRangeQuery> {
    let query = query?;
    let mut material_id: Option<String> = None;
    let mut offset: Option<u64> = None;
    let mut length: Option<u64> = None;

    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        match key {
            "materialId" => {
                if material_id.is_some() {
                    return None;
                }
                let decoded = percent_encoding::percent_decode_str(value)
                    .decode_utf8()
                    .ok()?
                    .into_owned();
                if decoded.is_empty() {
                    return None;
                }
                material_id = Some(decoded);
            }
            "offset" => {
                if offset.is_some() {
                    return None;
                }
                offset = Some(value.parse().ok()?);
            }
            "length" => {
                if length.is_some() {
                    return None;
                }
                length = Some(value.parse().ok()?);
            }
            _ => return None,
        }
    }

    Some(ManagedRangeQuery {
        material_id: material_id?,
        offset: offset?,
        length: length?,
    })
}

pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    responder.respond(build_response(context.app_handle(), &request));
}

fn build_response<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin = cors_origin(request);
    if request.method().as_str() != "GET" {
        return error_response(&origin, StatusCode::METHOD_NOT_ALLOWED);
    }

    let Some(query) = parse_query(request.uri().query()) else {
        return error_response(&origin, StatusCode::BAD_REQUEST);
    };

    let database = app.state::<DatabaseHandle>();
    let paths = app.state::<LibraryPaths>();
    let result = database.with_connection(|connection| {
        ImportRepository::new(connection).read_managed_range(
            &query.material_id,
            query.offset,
            query.length,
            &paths,
        )
    });

    match result {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("Access-Control-Allow-Origin", &origin)
            .header("Access-Control-Expose-Headers", "Content-Length")
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", bytes.len().to_string())
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(bytes)
            .expect("managed range response headers are valid"),
        Err(error) => error_response(&origin, error_status(&error)),
    }
}

fn cors_origin(request: &Request<Vec<u8>>) -> String {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if is_app_origin(origin) {
        origin.to_string()
    } else {
        // 不反射任意网页的 Origin；没有 Origin 的请求也不需要跨源读取授权。
        "null".to_string()
    }
}

fn is_app_origin(origin: &str) -> bool {
    origin == "http://tauri.localhost"
        || origin == "tauri://localhost"
        || origin == "http://localhost"
        || origin
            .strip_prefix("http://localhost:")
            .is_some_and(|port| {
                !port.is_empty() && port.chars().all(|character| character.is_ascii_digit())
            })
}

fn error_response(origin: &str, status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", origin)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Vec::new())
        .expect("managed range error response headers are valid")
}

fn error_status(error: &AppError) -> StatusCode {
    match error {
        AppError::MaterialNotFound(_) | AppError::ManagedFileMissing(_) => StatusCode::NOT_FOUND,
        AppError::InvalidMaterialId(_)
        | AppError::ManagedRangeTooLarge(_)
        | AppError::ManagedRangeOutOfBounds { .. } => StatusCode::BAD_REQUEST,
        AppError::Permission(_) => StatusCode::FORBIDDEN,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_material_id_and_half_open_range() {
        let query = parse_query(Some("materialId=mat-1&offset=12&length=128")).unwrap();
        assert_eq!(query.material_id, "mat-1");
        assert_eq!(query.offset, 12);
        assert_eq!(query.length, 128);
    }

    #[test]
    fn decodes_material_id_but_never_accepts_a_path_field() {
        let query = parse_query(Some("materialId=book%2Fone&offset=0&length=1")).unwrap();
        assert_eq!(query.material_id, "book/one");
        assert!(parse_query(Some("path=%2Fsecret&offset=0&length=1")).is_none());
    }

    #[test]
    fn rejects_missing_duplicate_or_invalid_query_fields() {
        assert!(parse_query(Some("materialId=mat-1&offset=0")).is_none());
        assert!(parse_query(Some("materialId=mat-1&offset=0&length=1&length=2")).is_none());
        assert!(parse_query(Some("materialId=mat-1&offset=-1&length=1")).is_none());
        assert!(parse_query(Some("materialId=mat-1&offset=0&length=x")).is_none());
        assert!(parse_query(Some("materialId=../outside&offset=0&length=1")).is_some());
    }

    #[test]
    fn maps_material_and_range_errors_without_exposing_file_paths() {
        assert_eq!(
            error_status(&AppError::MaterialNotFound("x".into())),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            error_status(&AppError::ManagedRangeTooLarge(8 * 1024 * 1024 + 1)),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            error_status(&AppError::Permission("C:/secret.pdf".into())),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn only_allows_tauri_or_local_dev_origins() {
        assert!(is_app_origin("http://tauri.localhost"));
        assert!(is_app_origin("http://localhost:5173"));
        assert!(is_app_origin("tauri://localhost"));
        assert!(!is_app_origin("https://example.com"));
        assert!(!is_app_origin("http://localhost:5173.evil.example"));
    }
}
