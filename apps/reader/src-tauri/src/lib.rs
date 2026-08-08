mod commands;
mod db;
mod error;
mod fs;

use db::{open_database, DatabaseHandle};
use error::AppError;
use fs::LibraryPaths;
use tauri::Manager;

const DATABASE_FILE_NAME: &str = "ai-reader.db";

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

            let connection = open_database(&app_dir.join(DATABASE_FILE_NAME))?;
            let paths = LibraryPaths::new(&app_dir)?;
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
            commands::workspace::load_workspace_state,
            commands::workspace::save_workspace_state,
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
            commands::import::recover_imports,
            commands::import::apply_material_metadata,
            commands::import::set_material_cover,
            commands::import::remove_material_cover,
            commands::import::restore_source_metadata,
            commands::import::read_material_cover,
        ])
        .run(tauri::generate_context!())
        .expect("启动 AI Reader 失败");
}
