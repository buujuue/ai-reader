use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 阅读位置(ReadingLocation):可序列化、可由 BookDocument 恢复的视图位置。
/// Rust 只原样存取,不理解渲染器语义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingLocation {
    pub kind: String,
    pub cfi: String,
}

/// 一个编辑器组内的一次阅读视图(标签)的可序列化描述。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingViewState {
    pub id: String,
    pub material_id: String,
    pub location: Option<ReadingLocation>,
}

/// 一个编辑器组的可序列化状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorGroupState {
    pub id: String,
    pub views: Vec<ReadingViewState>,
    pub active_view_id: Option<String>,
}

/// 工作区状态的持久化 DTO,serde 命名与 TypeScript 端保持一致(camelCase)。
/// Rust 只负责原样存取该结构,不理解其中的工作台语义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub schema_version: u32,
    pub primary_sidebar_visible: bool,
    pub active_editor_group_id: String,
    pub editor_groups: Vec<EditorGroupState>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            schema_version: 2,
            primary_sidebar_visible: true,
            active_editor_group_id: "group-1".to_string(),
            editor_groups: vec![EditorGroupState {
                id: "group-1".to_string(),
                views: Vec::new(),
                active_view_id: None,
            }],
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

    fn sample_state() -> WorkspaceState {
        WorkspaceState {
            schema_version: 2,
            primary_sidebar_visible: false,
            active_editor_group_id: "group-1".to_string(),
            editor_groups: vec![EditorGroupState {
                id: "group-1".to_string(),
                views: vec![ReadingViewState {
                    id: "view-1".to_string(),
                    material_id: "mat-1".to_string(),
                    location: Some(ReadingLocation {
                        kind: "epub".to_string(),
                        cfi: "epubcfi(/6/4[chap])!/4/2/2/1:0".to_string(),
                    }),
                }],
                active_view_id: Some("view-1".to_string()),
            }],
        }
    }

    /// 与 TypeScript 的 workspaceRepositoryContract 相同的三条契约,
    /// 使用相同的期望值,验证真实 SQLite 上的行为一致。
    fn assert_workspace_repository_contract(repository: &WorkspaceRepository<'_>) {
        assert_eq!(repository.load_state().unwrap(), WorkspaceState::default());

        repository.save_state(&sample_state()).unwrap();
        assert_eq!(repository.load_state().unwrap(), sample_state());

        repository.save_state(&WorkspaceState::default()).unwrap();
        assert_eq!(repository.load_state().unwrap(), WorkspaceState::default());
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

        assert_eq!(
            json,
            r#"{"schemaVersion":2,"primarySidebarVisible":true,"activeEditorGroupId":"group-1","editorGroups":[{"id":"group-1","views":[],"activeViewId":null}]}"#
        );
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