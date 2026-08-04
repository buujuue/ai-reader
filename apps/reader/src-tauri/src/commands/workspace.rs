use tauri::State;

use crate::db::workspace::{WorkspaceRepository, WorkspaceState};
use crate::db::DatabaseHandle;
use crate::error::AppError;

#[tauri::command]
pub fn load_workspace_state(
    database: State<'_, DatabaseHandle>,
) -> Result<WorkspaceState, AppError> {
    database.with_connection(|connection| WorkspaceRepository::new(connection).load_state())
}

#[tauri::command]
pub fn save_workspace_state(
    database: State<'_, DatabaseHandle>,
    state: WorkspaceState,
) -> Result<(), AppError> {
    database.with_connection(|connection| WorkspaceRepository::new(connection).save_state(&state))
}
