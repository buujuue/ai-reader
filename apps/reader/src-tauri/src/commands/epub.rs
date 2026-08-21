use tauri::State;

use crate::db::import::ImportRepository;
use crate::db::DatabaseHandle;
use crate::epub::NativeEpubPrefetch;
use crate::error::{classify_io_error, AppError};
use crate::fs::{atomic_write, LibraryPaths};

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

const MAX_DERIVED_TOC_CACHE_BYTES: usize = 4 * 1024 * 1024;

/// 读取 EPUB 推导目录缓存。缓存损坏由前端版本/结构校验后触发重建。
#[tauri::command]
pub fn read_epub_derived_toc_cache(
    paths: State<'_, LibraryPaths>,
    key: String,
) -> Result<Option<String>, AppError> {
    let path = paths.derived_toc_cache_path(&key)?;
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(classify_io_error(error)),
    }
}

/// 原子写入 EPUB 推导目录缓存;该缓存只保存小型目录 JSON,不保存原书正文。
#[tauri::command]
pub fn write_epub_derived_toc_cache(
    paths: State<'_, LibraryPaths>,
    key: String,
    value: String,
) -> Result<(), AppError> {
    if value.len() > MAX_DERIVED_TOC_CACHE_BYTES {
        return Err(AppError::InvalidDerivedTocCache(
            "目录缓存超过 4 MiB 上限".to_string(),
        ));
    }
    let path = paths.derived_toc_cache_path(&key)?;
    atomic_write(&path, value.as_bytes())
}
