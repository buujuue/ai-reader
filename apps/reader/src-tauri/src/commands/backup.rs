use std::path::Path;

use tauri::State;

use crate::db::backup::{BackupExportResult, BackupRepository, BackupRestoreResult};
use crate::db::DatabaseHandle;
use crate::error::AppError;
use crate::fs::LibraryPaths;

/// 以 Rust 流式导出完整书库快照。目标路径由前端保存对话框提供,
/// 归档成功前只写临时文件,失败时不会留下可被误认为成功的目标文件。
#[tauri::command]
pub fn export_library_backup(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    destination_path: String,
) -> Result<BackupExportResult, AppError> {
    database.with_connection(|connection| {
        BackupRepository::new(connection).export(&paths, Path::new(&destination_path))
    })
}

#[tauri::command]
pub fn restore_library_backup(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    source_path: String,
) -> Result<BackupRestoreResult, AppError> {
    database.restore_backup(&paths, Path::new(&source_path))
}
