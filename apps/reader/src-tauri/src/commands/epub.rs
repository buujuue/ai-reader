use tauri::State;

use crate::db::import::ImportRepository;
use crate::db::DatabaseHandle;
use crate::epub::NativeEpubPrefetch;
use crate::error::AppError;
use crate::fs::LibraryPaths;

/// 只按稳定 BookId 读取托管 EPUB 的机械预取数据。
///
/// OPF 元数据、目录、spine、CFI 和章节语义仍由前端 foliate-js 解析；
/// Rust 返回的只是减少 WebView ZIP 前置工作的字节与尺寸缓存。
#[tauri::command]
pub fn prefetch_managed_epub(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<NativeEpubPrefetch, AppError> {
    let managed_path = database.with_connection(|connection| {
        ImportRepository::new(connection).managed_file_path(&material_id, &paths)
    })?;
    crate::epub::prefetch(&managed_path).map_err(|error| AppError::EpubPrefetch(error.to_string()))
}
