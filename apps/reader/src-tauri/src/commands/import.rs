use base64::Engine;
use tauri::State;

use crate::db::import::{
    ImportRepository, ManagedFileInfo, MaterialMetadata, ReadingMaterial, StagedImport,
    VersionMigrationCommitRequest, VersionMigrationCommitResult, VersionMigrationSnapshot,
};
use crate::db::DatabaseHandle;
use crate::error::AppError;
use crate::fs::LibraryPaths;

fn set_managed_file_availability(material: &mut ReadingMaterial, paths: &LibraryPaths) {
    material.managed_file_available = paths.managed_path(&material.id).is_file();
}

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
        let mut material = ImportRepository::new(connection).commit(&staged, &metadata, &paths)?;
        set_managed_file_availability(&mut material, &paths);
        Ok(material)
    })
}

/// 列出活跃书库中的阅读材料。
#[tauri::command]
pub fn list_materials(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
) -> Result<Vec<ReadingMaterial>, AppError> {
    database.with_connection(|connection| {
        let mut materials = ImportRepository::new(connection).list_materials()?;
        for material in &mut materials {
            set_managed_file_availability(material, &paths);
        }
        Ok(materials)
    })
}

/// 列出回收站中的阅读材料(普通删除移除正文副本,仅从活跃书库隐藏)。
#[tauri::command]
pub fn list_trashed(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
) -> Result<Vec<ReadingMaterial>, AppError> {
    database.with_connection(|connection| {
        let mut materials = ImportRepository::new(connection).list_trashed()?;
        for material in &mut materials {
            set_managed_file_availability(material, &paths);
        }
        Ok(materials)
    })
}

/// 普通删除:把阅读材料移入回收站并移除正文副本,保留 BookId、封面与全部用户数据。
#[tauri::command]
pub fn trash_material(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<ReadingMaterial, AppError> {
    database.with_connection(|connection| {
        let mut material = ImportRepository::new(connection).trash(&material_id, &paths)?;
        set_managed_file_availability(&mut material, &paths);
        Ok(material)
    })
}

/// 从回收站恢复阅读材料,继续使用原 BookId 与全部阅读数据。
#[tauri::command]
pub fn restore_material(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<ReadingMaterial, AppError> {
    database.with_connection(|connection| {
        let mut material = ImportRepository::new(connection).restore(&material_id, &paths)?;
        set_managed_file_availability(&mut material, &paths);
        Ok(material)
    })
}

/// 用完整内容指纹相同的暂存文件恢复既有材料的托管副本。
#[tauri::command]
pub fn relink_material(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
    staged: StagedImport,
) -> Result<ReadingMaterial, AppError> {
    database.with_connection(|connection| {
        let mut material =
            ImportRepository::new(connection).relink(&material_id, &staged, &paths)?;
        set_managed_file_availability(&mut material, &paths);
        Ok(material)
    })
}

/// 永久删除回收站中的材料:级联清理托管文件、封面与记录。不可恢复。
#[tauri::command]
pub fn purge_material(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<(), AppError> {
    database.with_connection(|connection| {
        ImportRepository::new(connection).purge(&material_id, &paths)
    })
}

/// 返回活跃托管材料的只读来源描述。前端只获得名称和长度，不获得文件路径。
#[tauri::command]
pub fn get_managed_file_info(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<ManagedFileInfo, AppError> {
    database.with_connection(|connection| {
        ImportRepository::new(connection).managed_file_info(&material_id, &paths)
    })
}

/// 按半开区间 `[offset, offset + length)` 读取活跃托管材料的范围(base64)。
/// 命令只接受稳定 materialId 与范围参数，托管路径由 Rust 从数据库解析。
#[tauri::command]
pub fn read_managed_file_range(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
    offset: u64,
    length: u64,
) -> Result<String, AppError> {
    let bytes = database.with_connection(|connection| {
        ImportRepository::new(connection).read_managed_range(&material_id, offset, length, &paths)
    })?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 正式保存 Markdown 内容:由 Rust 原子替换托管文件、递增文档版本并更新完整内容指纹,
/// BookId 保持不变。TS 端不直接写文件。
#[tauri::command]
pub fn save_markdown(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
    content: String,
) -> Result<ReadingMaterial, AppError> {
    database.with_connection(|connection| {
        let mut material =
            ImportRepository::new(connection).save_markdown(&material_id, &content, &paths)?;
        set_managed_file_availability(&mut material, &paths);
        Ok(material)
    })
}

/// 启动时恢复:清理暂存目录与孤儿托管文件。
#[tauri::command]
pub fn recover_imports(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
) -> Result<(), AppError> {
    database.with_connection(|connection| ImportRepository::new(connection).recover(&paths))
}

/// 覆盖/清除阅读材料的标题与作者。title/author 为 null 表示清除该覆盖并回落来源。
#[tauri::command]
pub fn apply_material_metadata(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
    title: Option<String>,
    author: Option<String>,
) -> Result<ReadingMaterial, AppError> {
    database.with_connection(|connection| {
        let mut material = ImportRepository::new(connection).apply_metadata(
            &material_id,
            title.as_deref(),
            author.as_deref(),
        )?;
        set_managed_file_availability(&mut material, &paths);
        Ok(material)
    })
}

/// 把外部图片复制进托管封面空间并设为自定义封面。外部原文件不被修改或删除。
#[tauri::command]
pub fn set_material_cover(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
    source_path: String,
) -> Result<ReadingMaterial, AppError> {
    database.with_connection(|connection| {
        let mut material = ImportRepository::new(connection).set_cover(
            &material_id,
            std::path::Path::new(&source_path),
            &paths,
        )?;
        set_managed_file_availability(&mut material, &paths);
        Ok(material)
    })
}

/// 移除自定义封面:删除托管封面文件并清除封面覆盖,其他覆盖保留。
#[tauri::command]
pub fn remove_material_cover(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<ReadingMaterial, AppError> {
    database.with_connection(|connection| {
        let mut material = ImportRepository::new(connection).remove_cover(&material_id, &paths)?;
        set_managed_file_availability(&mut material, &paths);
        Ok(material)
    })
}

/// 一键清除标题、作者与封面的全部覆盖并恢复来源元数据。
#[tauri::command]
pub fn restore_source_metadata(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<ReadingMaterial, AppError> {
    database.with_connection(|connection| {
        let mut material =
            ImportRepository::new(connection).restore_source(&material_id, &paths)?;
        set_managed_file_availability(&mut material, &paths);
        Ok(material)
    })
}

/// 读取托管封面文件的原始字节(base64);无自定义封面时返回 null。
#[tauri::command]
pub fn read_material_cover(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    material_id: String,
) -> Result<Option<String>, AppError> {
    let bytes = database.with_connection(|connection| {
        ImportRepository::new(connection).read_cover(&material_id, &paths)
    })?;
    Ok(bytes.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// 用户确认后一次性提交 EPUB 版本迁移及全部迁移结果。
#[tauri::command]
pub fn commit_version_migration(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    request: VersionMigrationCommitRequest,
) -> Result<VersionMigrationCommitResult, AppError> {
    database.with_connection(|connection| {
        let mut result =
            ImportRepository::new(connection).commit_version_migration(&request, &paths)?;
        set_managed_file_availability(&mut result.material, &paths);
        Ok(result)
    })
}

/// 列出持续保留的本地版本迁移恢复快照。
#[tauri::command]
pub fn list_version_migration_snapshots(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
) -> Result<Vec<VersionMigrationSnapshot>, AppError> {
    database.with_connection(|connection| {
        ImportRepository::new(connection).list_version_migration_snapshots(&paths)
    })
}

/// 用户明确清除一份版本迁移恢复快照。
#[tauri::command]
pub fn clear_version_migration_snapshot(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    snapshot_id: String,
) -> Result<(), AppError> {
    database.with_connection(|connection| {
        ImportRepository::new(connection).clear_version_migration_snapshot(&snapshot_id, &paths)
    })
}

/// 完整恢复迁移前的数据库、托管 EPUB、批注与工作区状态;快照本身继续保留。
#[tauri::command]
pub fn restore_version_migration_snapshot(
    database: State<'_, DatabaseHandle>,
    paths: State<'_, LibraryPaths>,
    snapshot_id: String,
) -> Result<crate::db::import::VersionMigrationRestoreResult, AppError> {
    let mut result = database.restore_version_migration_snapshot(&paths, &snapshot_id)?;
    set_managed_file_availability(&mut result.material, &paths);
    Ok(result)
}
