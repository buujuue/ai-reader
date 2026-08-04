use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 工作区状态的持久化 DTO,serde 命名与 TypeScript 端保持一致(camelCase)。
/// Rust 只负责原样存取该结构,不理解其中的工作台语义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub schema_version: u32,
    pub primary_sidebar_visible: bool,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            primary_sidebar_visible: true,
        }
    }
}

/// 工作区状态的 typed repository。与 TypeScript 内存 Adapter 共享同一契约:
/// 空库返回默认状态;保存后可加载同一状态;再次保存覆盖先前状态。
pub struct WorkspaceRepository<'a> {
    connection: &'a Connection,
}

impl<'a> WorkspaceRepository<'a> {
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    pub fn load_state(&self) -> Result<WorkspaceState, AppError> {
        let mut statement = self
            .connection
            .prepare("SELECT json FROM workspace_state WHERE id = 1")?;
        let mut rows = statement.query([])?;
        match rows.next()? {
            Some(row) => {
                let json: String = row.get(0)?;
                Ok(serde_json::from_str(&json)?)
            }
            None => Ok(WorkspaceState::default()),
        }
    }

    pub fn save_state(&self, state: &WorkspaceState) -> Result<(), AppError> {
        let json = serde_json::to_string(state).map_err(AppError::WorkspaceStateSerialize)?;
        self.connection.execute(
            "INSERT INTO workspace_state (id, json, updated_at)
             VALUES (1, ?1, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
                json = excluded.json,
                updated_at = excluded.updated_at",
            [&json],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workspace_state (
                    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
                    json TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );",
            )
            .unwrap();
        connection
    }

    /// 与 TypeScript 的 workspaceRepositoryContract 相同的三条契约,
    /// 使用相同的期望值,验证真实 SQLite 上的行为一致。
    fn assert_workspace_repository_contract(repository: &WorkspaceRepository<'_>) {
        assert_eq!(repository.load_state().unwrap(), WorkspaceState::default());

        repository
            .save_state(&WorkspaceState {
                schema_version: 1,
                primary_sidebar_visible: false,
            })
            .unwrap();
        assert_eq!(
            repository.load_state().unwrap(),
            WorkspaceState {
                schema_version: 1,
                primary_sidebar_visible: false,
            }
        );

        repository
            .save_state(&WorkspaceState {
                schema_version: 1,
                primary_sidebar_visible: true,
            })
            .unwrap();
        assert_eq!(
            repository.load_state().unwrap(),
            WorkspaceState {
                schema_version: 1,
                primary_sidebar_visible: true,
            }
        );
    }

    #[test]
    fn workspace_repository_satisfies_contract_on_sqlite() {
        let connection = migrated_connection();
        let repository = WorkspaceRepository::new(&connection);
        assert_workspace_repository_contract(&repository);
    }

    #[test]
    fn workspace_state_serializes_to_camel_case_dto() {
        let json = serde_json::to_string(&WorkspaceState::default()).unwrap();

        assert_eq!(json, r#"{"schemaVersion":1,"primarySidebarVisible":true}"#);
    }

    #[test]
    fn corrupted_state_json_surfaces_typed_error() {
        let connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO workspace_state (id, json) VALUES (1, '{not-json')",
                [],
            )
            .unwrap();
        let repository = WorkspaceRepository::new(&connection);

        let error = repository.load_state().unwrap_err();
        assert!(matches!(error, AppError::WorkspaceStateParse(_)));
    }
}
