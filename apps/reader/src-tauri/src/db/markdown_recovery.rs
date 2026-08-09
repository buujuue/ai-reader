use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{classify_io_error, AppError};
use crate::fs::{atomic_write, LibraryPaths};

const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMarkdownRecovery {
    schema_version: u32,
    material_id: String,
    content: String,
    base_document_version: i64,
    updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkdownRecoveryStatus {
    Available,
    Conflict,
    Corrupt,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownRecoverySnapshot {
    pub material_id: String,
    pub content: Option<String>,
    pub base_document_version: Option<i64>,
    pub updated_at: Option<u64>,
    pub status: MarkdownRecoveryStatus,
}

/// Markdown 恢复快照 Repository。快照位于应用私有文件系统，SQLite 只用于
/// 对比正式文档版本；快照绝不修改正式材料、指纹或文档版本。
pub struct MarkdownRecoveryRepository<'a> {
    connection: &'a Connection,
}

impl<'a> MarkdownRecoveryRepository<'a> {
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    pub fn write(
        &self,
        material_id: &str,
        content: &str,
        base_document_version: i64,
        paths: &LibraryPaths,
    ) -> Result<(), AppError> {
        self.current_version(material_id)?
            .ok_or_else(|| AppError::MaterialNotFound(material_id.to_string()))?;
        let snapshot = StoredMarkdownRecovery {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            material_id: material_id.to_string(),
            content: content.to_string(),
            base_document_version,
            updated_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };
        let bytes = serde_json::to_vec(&snapshot).map_err(AppError::MarkdownRecoverySerialize)?;
        atomic_write(&paths.recovery_path(material_id)?, &bytes)
    }

    pub fn list(&self, paths: &LibraryPaths) -> Result<Vec<MarkdownRecoverySnapshot>, AppError> {
        let mut snapshots = Vec::new();
        for entry in std::fs::read_dir(&paths.recovery_dir).map_err(classify_io_error)? {
            let entry = entry.map_err(classify_io_error)?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let material_id = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default()
                .to_string();
            let parsed = std::fs::read(&path)
                .map_err(classify_io_error)
                .and_then(|bytes| {
                    serde_json::from_slice::<StoredMarkdownRecovery>(&bytes)
                        .map_err(AppError::MarkdownRecoverySerialize)
                });
            let snapshot = match parsed {
                Ok(stored)
                    if stored.schema_version == SNAPSHOT_SCHEMA_VERSION
                        && stored.material_id == material_id =>
                {
                    let current_version = self.current_version(&material_id)?;
                    let status = if current_version == Some(stored.base_document_version) {
                        MarkdownRecoveryStatus::Available
                    } else {
                        MarkdownRecoveryStatus::Conflict
                    };
                    MarkdownRecoverySnapshot {
                        material_id,
                        content: Some(stored.content),
                        base_document_version: Some(stored.base_document_version),
                        updated_at: Some(stored.updated_at),
                        status,
                    }
                }
                _ => MarkdownRecoverySnapshot {
                    material_id,
                    content: None,
                    base_document_version: None,
                    updated_at: None,
                    status: MarkdownRecoveryStatus::Corrupt,
                },
            };
            snapshots.push(snapshot);
        }
        snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.updated_at));
        Ok(snapshots)
    }

    pub fn discard(&self, material_id: &str, paths: &LibraryPaths) -> Result<(), AppError> {
        let path = paths.recovery_path(material_id)?;
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(classify_io_error(error)),
        }
    }

    fn current_version(&self, material_id: &str) -> Result<Option<i64>, AppError> {
        self.connection
            .query_row(
                "SELECT document_version FROM materials WHERE id = ?1 AND status = 'ready'",
                [material_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{run_migrations, MIGRATIONS};
    use crate::fs::LibraryPaths;
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-reader-markdown-recovery-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn setup() -> (Connection, LibraryPaths, String) {
        let mut connection = Connection::open_in_memory().unwrap();
        run_migrations(&mut connection, MIGRATIONS).unwrap();
        let root = temp_dir();
        let paths = LibraryPaths::new(&root).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        connection
            .execute(
                "INSERT INTO materials
                 (id, status, fingerprint, title, source_file_name, document_version)
                 VALUES (?1, 'ready', 'fingerprint-v0', '笔记', 'book.md', 0)",
                [&id],
            )
            .unwrap();
        std::fs::write(paths.managed_path(&id), b"formal-v0").unwrap();
        (connection, paths, id)
    }

    #[test]
    fn snapshot_roundtrips_without_changing_formal_material() {
        let (connection, paths, id) = setup();
        let repository = MarkdownRecoveryRepository::new(&connection);

        repository.write(&id, "dirty buffer", 0, &paths).unwrap();

        let snapshots = repository.list(&paths).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].material_id, id);
        assert_eq!(snapshots[0].content.as_deref(), Some("dirty buffer"));
        assert_eq!(snapshots[0].base_document_version, Some(0));
        assert_eq!(snapshots[0].status, MarkdownRecoveryStatus::Available);
        assert_eq!(
            std::fs::read(paths.managed_path(&id)).unwrap(),
            b"formal-v0"
        );
        let version: i64 = connection
            .query_row(
                "SELECT document_version FROM materials WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 0);
    }

    #[test]
    fn changed_base_version_marks_snapshot_as_conflict() {
        let (connection, paths, id) = setup();
        let repository = MarkdownRecoveryRepository::new(&connection);
        repository.write(&id, "dirty buffer", 0, &paths).unwrap();
        connection
            .execute(
                "UPDATE materials SET document_version = 1 WHERE id = ?1",
                [&id],
            )
            .unwrap();

        let snapshots = repository.list(&paths).unwrap();

        assert_eq!(snapshots[0].status, MarkdownRecoveryStatus::Conflict);
    }

    #[test]
    fn repeated_snapshot_write_atomically_keeps_latest_buffer() {
        let (connection, paths, id) = setup();
        let repository = MarkdownRecoveryRepository::new(&connection);

        repository.write(&id, "first", 0, &paths).unwrap();
        repository.write(&id, "latest", 0, &paths).unwrap();

        let snapshots = repository.list(&paths).unwrap();
        assert_eq!(snapshots[0].content.as_deref(), Some("latest"));
    }

    #[test]
    fn corrupt_snapshot_is_reported_without_blocking_formal_material() {
        let (connection, paths, id) = setup();
        std::fs::write(paths.recovery_path(&id).unwrap(), b"not-json").unwrap();
        let repository = MarkdownRecoveryRepository::new(&connection);

        let snapshots = repository.list(&paths).unwrap();

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].material_id, id);
        assert_eq!(snapshots[0].status, MarkdownRecoveryStatus::Corrupt);
        assert_eq!(snapshots[0].content, None);
        assert_eq!(
            std::fs::read(paths.managed_path(&id)).unwrap(),
            b"formal-v0"
        );
    }

    #[test]
    fn discard_is_idempotent() {
        let (connection, paths, id) = setup();
        let repository = MarkdownRecoveryRepository::new(&connection);
        repository.write(&id, "dirty buffer", 0, &paths).unwrap();

        repository.discard(&id, &paths).unwrap();
        repository.discard(&id, &paths).unwrap();

        assert!(repository.list(&paths).unwrap().is_empty());
    }

    #[test]
    fn snapshot_survives_database_close_and_application_restart() {
        let root = temp_dir();
        let database_path = root.join("ai-reader.db");
        let paths = LibraryPaths::new(&root).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut connection = Connection::open(&database_path).unwrap();
            run_migrations(&mut connection, MIGRATIONS).unwrap();
            connection
                .execute(
                    "INSERT INTO materials
                     (id, status, fingerprint, title, source_file_name, document_version)
                     VALUES (?1, 'ready', 'fingerprint-v0', '笔记', 'book.md', 0)",
                    [&id],
                )
                .unwrap();
            MarkdownRecoveryRepository::new(&connection)
                .write(&id, "关闭前未保存内容", 0, &paths)
                .unwrap();
        }

        let connection = Connection::open(&database_path).unwrap();
        let snapshots = MarkdownRecoveryRepository::new(&connection)
            .list(&paths)
            .unwrap();

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].material_id, id);
        assert_eq!(snapshots[0].content.as_deref(), Some("关闭前未保存内容"));
        assert_eq!(snapshots[0].status, MarkdownRecoveryStatus::Available);
    }
}
