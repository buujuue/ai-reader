use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 阅读排版设置(字体、字号、行距、页边距、主题、分页/滚动)。
/// Rust 只原样存取,不参与排版语义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingTypography {
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub margin: f64,
    pub gap: f64,
    pub flow: String,
    pub theme: String,
}

impl Default for ReadingTypography {
    fn default() -> Self {
        Self {
            font_family: "sansSerif".to_string(),
            font_size: 18.0,
            line_height: 1.6,
            margin: 48.0,
            gap: 7.0,
            flow: "paginated".to_string(),
            theme: "light".to_string(),
        }
    }
}

/// 阅读位置(ReadingLocation):可序列化、可由 BookDocument 恢复的视图位置。
/// Rust 只原样存取,不理解渲染器语义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingLocation {
    pub kind: String,
    pub cfi: String,
}

/// 导航历史节点结构。Rust 只原样存取,不理解导航语义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationHistory {
    pub positions: Vec<ReadingLocation>,
    pub index: i64,
}

impl Default for NavigationHistory {
    fn default() -> Self {
        Self {
            positions: Vec::new(),
            index: -1,
        }
    }
}

/// 一个编辑器组内的一次阅读视图(标签)的可序列化描述。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingViewState {
    pub id: String,
    pub material_id: String,
    pub location: Option<ReadingLocation>,
    #[serde(default)]
    pub history: NavigationHistory,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub schema_version: u32,
    pub primary_sidebar_visible: bool,
    pub active_editor_group_id: String,
    pub editor_groups: Vec<EditorGroupState>,
    /// 全局阅读默认设置。旧数据缺失时回退到默认值。
    #[serde(default)]
    pub global_reading_typography: ReadingTypography,
    /// 阅读材料级排版覆盖;键为 BookId。旧数据缺失时为空。
    #[serde(default)]
    pub material_typography: HashMap<String, PartialTypography>,
}

/// 材料级排版覆盖:允许只覆盖部分字段,未覆盖字段沿用全局默认。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialTypography {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            schema_version: 4,
            primary_sidebar_visible: true,
            active_editor_group_id: "group-1".to_string(),
            editor_groups: vec![EditorGroupState {
                id: "group-1".to_string(),
                views: Vec::new(),
                active_view_id: None,
            }],
            global_reading_typography: ReadingTypography::default(),
            material_typography: HashMap::new(),
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
        let mut material_typography = HashMap::new();
        material_typography.insert(
            "mat-1".to_string(),
            PartialTypography {
                font_size: Some(22.0),
                flow: Some("scrolled".to_string()),
                ..PartialTypography::default()
            },
        );
        WorkspaceState {
            schema_version: 4,
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
                    history: NavigationHistory {
                        positions: vec![ReadingLocation {
                            kind: "epub".to_string(),
                            cfi: "epubcfi(/6/3)".to_string(),
                        }],
                        index: 0,
                    },
                }],
                active_view_id: Some("view-1".to_string()),
            }],
            global_reading_typography: ReadingTypography {
                font_family: "serif".to_string(),
                font_size: 20.0,
                line_height: 1.8,
                margin: 40.0,
                gap: 8.0,
                flow: "paginated".to_string(),
                theme: "sepia".to_string(),
            },
            material_typography,
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
            r#"{"schemaVersion":4,"primarySidebarVisible":true,"activeEditorGroupId":"group-1","editorGroups":[{"id":"group-1","views":[],"activeViewId":null}],"globalReadingTypography":{"fontFamily":"sansSerif","fontSize":18.0,"lineHeight":1.6,"margin":48.0,"gap":7.0,"flow":"paginated","theme":"light"},"materialTypography":{}}"#
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