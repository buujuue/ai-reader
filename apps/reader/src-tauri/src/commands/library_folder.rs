use tauri::State;

use crate::db::folders::{LibraryFolder, LibraryFolderDeletionResult, LibraryFolderRepository};
use crate::db::DatabaseHandle;
use crate::error::AppError;

#[tauri::command]
pub fn list_library_folders(
    database: State<'_, DatabaseHandle>,
) -> Result<Vec<LibraryFolder>, AppError> {
    database.with_connection(|connection| LibraryFolderRepository::new(connection).list())
}

#[tauri::command]
pub fn create_library_folder(
    database: State<'_, DatabaseHandle>,
    name: String,
    parent_id: Option<String>,
) -> Result<LibraryFolder, AppError> {
    database.with_connection(|connection| {
        LibraryFolderRepository::new(connection).create(&name, parent_id.as_deref())
    })
}

#[tauri::command]
pub fn rename_library_folder(
    database: State<'_, DatabaseHandle>,
    folder_id: String,
    name: String,
) -> Result<LibraryFolder, AppError> {
    database.with_connection(|connection| {
        LibraryFolderRepository::new(connection).rename(&folder_id, &name)
    })
}

#[tauri::command]
pub fn delete_library_folder(
    database: State<'_, DatabaseHandle>,
    folder_id: String,
) -> Result<LibraryFolderDeletionResult, AppError> {
    database
        .with_connection(|connection| LibraryFolderRepository::new(connection).delete(&folder_id))
}
