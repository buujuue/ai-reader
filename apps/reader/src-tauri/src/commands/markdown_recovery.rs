use tauri::State;

use crate::db::markdown_recovery::{MarkdownRecoveryRepository, MarkdownRecoverySnapshot};
use crate::db::DatabaseHandle;
use crate::error::AppError;
use crate::fs::LibraryPaths;

/// 原子写入脏 Markdown 缓冲区的恢复快照，不改变正式材料。
#[tauri::command]
pub fn write_markdown_recovery(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
    content: String,
    base_document_version: i64,
) -> Result<(), AppError> {
    database.with_connection(|connection| {
        MarkdownRecoveryRepository::new(connection).write(
            &material_id,
            &content,
            base_document_version,
            &paths,
        )
    })
}

/// 列出启动时可处理的 Markdown 恢复快照，并标记版本冲突或损坏状态。
#[tauri::command]
pub fn list_markdown_recoveries(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
) -> Result<Vec<MarkdownRecoverySnapshot>, AppError> {
    database.with_connection(|connection| MarkdownRecoveryRepository::new(connection).list(&paths))
}

/// 显式丢弃 Markdown 恢复快照；不存在时幂等。
#[tauri::command]
pub fn discard_markdown_recovery(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<(), AppError> {
    database.with_connection(|connection| {
        MarkdownRecoveryRepository::new(connection).discard(&material_id, &paths)
    })
}
