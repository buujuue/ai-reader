use base64::Engine;
use tauri::State;

use crate::db::import::{ImportRepository, MaterialMetadata, ReadingMaterial, StagedImport};
use crate::db::DatabaseHandle;
use crate::error::AppError;
use crate::fs::LibraryPaths;

/// 暂存一份 EPUB:把外部文件全部字节流式复制到暂存区并计算完整内容指纹。
/// 参数为外部文件路径,由前端系统文件选择器提供。
#[tauri::command]
pub fn stage_import(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    source_path: String,
) -> Result<StagedImport, AppError> {
    database.with_connection(|connection| {
        ImportRepository::new(connection).stage(std::path::Path::new(&source_path), &paths)
    })
}

/// 读取暂存文件字节(base64),交给 TypeScript 端检查格式与提取元数据。
#[tauri::command]
pub fn read_staged_file(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    staged: StagedImport,
) -> Result<String, AppError> {
    let bytes = database.with_connection(|connection| {
        ImportRepository::new(connection).read_staged(&staged, &paths)
    })?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 丢弃一份不再需要的暂存文件(检查失败或用户中止时由前端调用)。
#[tauri::command]
pub fn discard_import(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    staged: StagedImport,
) -> Result<(), AppError> {
    database.with_connection(|connection| ImportRepository::new(connection).discard(&staged, &paths))
}

/// 提交导入:去重、生成 BookId、写入 ready 记录并原子移动托管文件。
#[tauri::command]
pub fn commit_import(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    staged: StagedImport,
    metadata: MaterialMetadata,
) -> Result<ReadingMaterial, AppError> {
    database.with_connection(|connection| {
        ImportRepository::new(connection).commit(&staged, &metadata, &paths)
    })
}

/// 列出活跃书库中的阅读材料。
#[tauri::command]
pub fn list_materials(
    database: State<'_, DatabaseHandle>,
) -> Result<Vec<ReadingMaterial>, AppError> {
    database.with_connection(|connection| ImportRepository::new(connection).list_materials())
}

/// 读取已提交托管文件的原始字节(base64),交给前端 BookDocument 打开阅读。
#[tauri::command]
pub fn read_managed_file(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<String, AppError> {
    let bytes = database.with_connection(|connection| {
        ImportRepository::new(connection).read_managed(&material_id, &paths)
    })?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 启动时恢复:清理暂存目录与孤儿托管文件。
#[tauri::command]
pub fn recover_imports(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
) -> Result<(), AppError> {
    database.with_connection(|connection| ImportRepository::new(connection).recover(&paths))
}
