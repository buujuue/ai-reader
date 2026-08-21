mod commands;
mod db;
mod epub;
mod error;
mod fs;

use db::{open_database, DatabaseHandle};
use error::AppError;
use fs::LibraryPaths;
use tauri::Manager;

const DATABASE_FILE_NAME: &str = "ai-reader.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|source| AppError::AppDir(source.to_string()))?;
            std::fs::create_dir_all(&app_dir)
                .map_err(|source| AppError::AppDir(source.to_string()))?;

            let paths = LibraryPaths::new(&app_dir)?;
            // 恢复切换可能在上一次进程异常终止时停在数据库文件替换中，必须在打开 SQLite 前处理。
            db::backup::recover_library_restore(&paths)?;
            db::import::recover_version_migrations(&paths)?;
            let connection = open_database(&app_dir.join(DATABASE_FILE_NAME))?;
            app.manage(DatabaseHandle::new(connection));
            app.manage(paths.clone());

            // 启动时恢复中断的导入,确保不残留半本书或半条记录。
            app.state::<DatabaseHandle>()
                .with_connection(|connection| {
                    db::import::ImportRepository::new(connection).recover(&paths)
                })?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::epub::prefetch_managed_epub,
            commands::epub::read_epub_derived_toc_cache,
            commands::epub::write_epub_derived_toc_cache,
            commands::backup::export_library_backup,
            commands::backup::restore_library_backup,
            commands::workspace::load_workspace_state,
            commands::workspace::save_workspace_state,
            commands::annotations::list_annotations,
            commands::annotations::list_deleted_annotations,
            commands::annotations::save_annotation,
            commands::annotations::save_annotations,
            commands::annotations::delete_annotation,
            commands::annotations::restore_annotation,
            commands::annotations::write_annotation_markdown,
            commands::import::stage_import,
            commands::import::read_staged_file,
            commands::import::discard_import,
            commands::import::commit_import,
            commands::import::list_materials,
            commands::import::list_trashed,
            commands::import::trash_material,
            commands::import::restore_material,
            commands::import::purge_material,
            commands::import::read_managed_file,
            commands::import::save_markdown,
            commands::import::recover_imports,
            commands::import::apply_material_metadata,
            commands::import::set_material_cover,
            commands::import::remove_material_cover,
            commands::import::restore_source_metadata,
            commands::import::read_material_cover,
            commands::import::commit_version_migration,
            commands::import::list_version_migration_snapshots,
            commands::import::restore_version_migration_snapshot,
            commands::import::clear_version_migration_snapshot,
            commands::markdown_recovery::write_markdown_recovery,
            commands::markdown_recovery::list_markdown_recoveries,
            commands::markdown_recovery::discard_markdown_recovery,
        ])
        .run(tauri::generate_context!())
        .expect("启动 AI Reader 失败");
}
