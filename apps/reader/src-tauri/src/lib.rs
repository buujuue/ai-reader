mod commands;
mod db;
mod error;

use db::{open_database, DatabaseHandle};
use error::AppError;
use tauri::Manager;

const DATABASE_FILE_NAME: &str = "ai-reader.db";

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|source| AppError::AppDir(source.to_string()))?;
            std::fs::create_dir_all(&app_dir)
                .map_err(|source| AppError::AppDir(source.to_string()))?;

            let connection = open_database(&app_dir.join(DATABASE_FILE_NAME))?;
            app.manage(DatabaseHandle::new(connection));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace::load_workspace_state,
            commands::workspace::save_workspace_state,
        ])
        .run(tauri::generate_context!())
        .expect("启动 AI Reader 失败");
}
