pub mod annotations;
pub mod backup;
pub mod import;
pub mod markdown_recovery;
pub mod workspace;

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::AppError;

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("migrations/0001_workspace.sql")),
    (2, include_str!("migrations/0002_materials.sql")),
    (3, include_str!("migrations/0003_import_pending.sql")),
    (4, include_str!("migrations/0004_material_overrides.sql")),
    (5, include_str!("migrations/0005_material_trash.sql")),
    (6, include_str!("migrations/0006_annotations.sql")),
    (
        7,
        include_str!("migrations/0007_material_document_version.sql"),
    ),
    (8, include_str!("migrations/0008_import_identity.sql")),
    (
        9,
        include_str!("migrations/0009_annotation_recovery_state.sql"),
    ),
];

/// 打开数据库连接并应用全部迁移。
/// SQLite 连接、迁移与 pragma 规则由 Rust 独占,TS 不接触数据库路径与 SQL。
pub fn open_database(path: &Path) -> Result<Connection, AppError> {
    let mut connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    run_migrations(&mut connection, MIGRATIONS)?;
    Ok(connection)
}

fn run_migrations(connection: &mut Connection, migrations: &[(i64, &str)]) -> Result<(), AppError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    let current_version: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;

    for (version, sql) in migrations {
        if *version <= current_version {
            continue;
        }
        let transaction = connection.transaction()?;
        transaction.execute_batch(sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version) VALUES (?1)",
            [version],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

/// Tauri 托管状态:把 SQLite 连接包成窄接口。
/// 命令层只能通过 with_connection 访问数据库,不暴露连接本身。
pub struct DatabaseHandle {
    connection: std::sync::Mutex<Option<Connection>>,
}

impl DatabaseHandle {
    pub fn new(connection: Connection) -> Self {
        Self {
            connection: std::sync::Mutex::new(Some(connection)),
        }
    }

    pub fn with_connection<T>(
        &self,
        action: impl FnOnce(&Connection) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let guard = self
            .connection
            .lock()
            .map_err(|_| AppError::DatabaseLocked)?;
        let connection = guard.as_ref().ok_or(AppError::DatabaseLocked)?;
        action(connection)
    }

    pub fn restore_backup(
        &self,
        paths: &crate::fs::LibraryPaths,
        source: &Path,
    ) -> Result<backup::BackupRestoreResult, AppError> {
        let mut guard = self
            .connection
            .lock()
            .map_err(|_| AppError::DatabaseLocked)?;
        let connection = guard.as_ref().ok_or(AppError::DatabaseLocked)?;
        backup::BackupRepository::prepare_restore(connection, paths, source)?;

        // 丢弃旧连接后再切换数据库文件，避免 Windows 上 SQLite 文件句柄阻止原子替换。
        guard.take();
        match backup::complete_restore(paths) {
            Ok(result) => match open_database(&paths.database_path()) {
                Ok(connection) => {
                    *guard = Some(connection);
                    match backup::finish_restore(paths) {
                        Ok(()) => Ok(result),
                        Err(error) => {
                            guard.take();
                            recover_failed_restore(&mut guard, paths, error, "完成恢复状态写入失败")
                        }
                    }
                }
                Err(error) => recover_failed_restore(&mut guard, paths, error, "新数据库无法打开"),
            },
            Err(error) => recover_failed_restore(&mut guard, paths, error, "切换失败"),
        }
    }

    /// 恢复一份显式版本迁移快照。迁移快照不是备份归档,但同样必须先释放
    /// SQLite 连接再切换数据库文件,否则 Windows 可能持有旧文件句柄。
    pub fn restore_version_migration_snapshot(
        &self,
        paths: &crate::fs::LibraryPaths,
        snapshot_id: &str,
    ) -> Result<import::VersionMigrationRestoreResult, AppError> {
        let mut guard = self
            .connection
            .lock()
            .map_err(|_| AppError::DatabaseLocked)?;
        let connection = guard.as_ref().ok_or(AppError::DatabaseLocked)?;
        let snapshot_dir = paths.version_migration_path(snapshot_id)?;
        let snapshot_db = snapshot_dir.join("database.sqlite");
        let snapshot_material = snapshot_dir.join("material.epub");
        if !snapshot_db.is_file() || !snapshot_material.is_file() {
            return Err(AppError::BackupValidation(format!(
                "迁移恢复快照不完整:{snapshot_id}"
            )));
        }
        let material_id = import::read_version_migration_material_id(&snapshot_dir)?;
        let current_material = paths.managed_path(&material_id);
        let safety_id = uuid::Uuid::new_v4().to_string();
        let safety_db = paths
            .stash_dir
            .join(format!(".migration-restore-{safety_id}.sqlite"));
        let safety_material = paths
            .stash_dir
            .join(format!(".migration-restore-{safety_id}.material"));
        let had_current_material = current_material.is_file();
        connection.backup("main", &safety_db, None)?;
        if had_current_material {
            crate::fs::atomic_copy(&current_material, &safety_material)?;
        }

        guard.take();
        let result = (|| {
            crate::fs::atomic_copy(&snapshot_db, &paths.database_path())?;
            crate::fs::atomic_copy(&snapshot_material, &current_material)?;
            let reopened = open_database(&paths.database_path())?;
            import::ImportRepository::new(&reopened).recover(paths)?;
            let material = import::ImportRepository::new(&reopened)
                .list_materials()?
                .into_iter()
                .chain(import::ImportRepository::new(&reopened).list_trashed()?)
                .find(|item| item.id == material_id)
                .ok_or_else(|| AppError::MaterialNotFound(material_id.clone()))?;
            let annotations = {
                let repository = annotations::AnnotationRepository::new(&reopened);
                let mut values = repository.list_by_material(&material_id)?;
                values.extend(repository.list_deleted_by_material(&material_id)?);
                values
            };
            let workspace_state = serde_json::to_value(
                workspace::WorkspaceRepository::new(&reopened).load_state()?,
            )
            .map_err(AppError::WorkspaceStateSerialize)?;
            *guard = Some(reopened);
            Ok(import::VersionMigrationRestoreResult {
                material,
                annotations,
                workspace_state,
            })
        })();

        match result {
            Ok(value) => {
                let _ = std::fs::remove_file(safety_db);
                let _ = std::fs::remove_file(safety_material);
                Ok(value)
            }
            Err(error) => {
                guard.take();
                let rollback = crate::fs::atomic_copy(&safety_db, &paths.database_path()).and_then(
                    |_| {
                        if had_current_material {
                            crate::fs::atomic_copy(&safety_material, &current_material)
                        } else {
                            match std::fs::remove_file(&current_material) {
                                Ok(()) => Ok(()),
                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                                Err(error) => Err(crate::error::classify_io_error(error)),
                            }
                        }
                    },
                )
                .and_then(|_| open_database(&paths.database_path()));
                match rollback {
                    Ok(reopened) => {
                        *guard = Some(reopened);
                        let _ = std::fs::remove_file(safety_db);
                        let _ = std::fs::remove_file(safety_material);
                        Err(error)
                    }
                    Err(rollback_error) => Err(AppError::BackupRestore(format!(
                        "迁移恢复失败:{error}; 回滚失败:{rollback_error}"
                    ))),
                }
            }
        }
    }
}

fn recover_failed_restore(
    guard: &mut std::sync::MutexGuard<'_, Option<Connection>>,
    paths: &crate::fs::LibraryPaths,
    error: AppError,
    context: &str,
) -> Result<backup::BackupRestoreResult, AppError> {
    let rollback = backup::rollback_restore(paths);
    let reopened = open_database(&paths.database_path());
    match (rollback, reopened) {
        (Ok(()), Ok(connection)) => {
            **guard = Some(connection);
            Err(error)
        }
        (rollback, reopened) => {
            let details = match (rollback, reopened) {
                (Err(rollback_error), Err(reopen_error)) => {
                    format!("{context}:{error}; 回滚失败:{rollback_error}; 原书库无法打开:{reopen_error}")
                }
                (Err(rollback_error), Ok(connection)) => {
                    **guard = Some(connection);
                    format!("{context}:{error}; 回滚失败:{rollback_error}")
                }
                (Ok(()), Err(reopen_error)) => {
                    format!("{context}:{error}; 原书库无法打开:{reopen_error}")
                }
                (Ok(()), Ok(_)) => unreachable!(),
            };
            Err(AppError::BackupRestore(details))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn tables(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|name| name.unwrap())
            .collect()
    }

    #[test]
    fn migrations_create_schema_on_in_memory_database() {
        let mut connection = Connection::open_in_memory().unwrap();
        run_migrations(&mut connection, MIGRATIONS).unwrap();

        let tables = tables(&connection);
        assert!(tables.contains(&"schema_migrations".to_string()));
        assert!(tables.contains(&"workspace_state".to_string()));
        assert!(tables.contains(&"materials".to_string()));
        assert!(tables.contains(&"material_overrides".to_string()));
        assert!(tables.contains(&"annotations".to_string()));
    }

    #[test]
    fn migrations_are_idempotent() {
        let mut connection = Connection::open_in_memory().unwrap();
        run_migrations(&mut connection, MIGRATIONS).unwrap();
        run_migrations(&mut connection, MIGRATIONS).unwrap();

        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 9);
    }

    #[test]
    fn import_identity_migration_keeps_one_historical_ready_duplicate() {
        let mut connection = Connection::open_in_memory().unwrap();
        run_migrations(&mut connection, &MIGRATIONS[..7]).unwrap();
        connection
            .execute(
                "INSERT INTO materials
                 (id, status, fingerprint, title, source_file_name)
                 VALUES ('a', 'ready', 'same', 'A', 'a.epub'),
                        ('b', 'ready', 'same', 'B', 'b.epub')",
                [],
            )
            .unwrap();

        run_migrations(&mut connection, &MIGRATIONS[7..]).unwrap();

        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM materials WHERE fingerprint = 'same' AND status = 'ready'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1);
        assert!(connection
            .query_row("SELECT 1 FROM materials WHERE id = 'a'", [], |_| Ok(()))
            .is_ok());
    }

    #[test]
    fn failed_migration_rolls_back_without_partial_state() {
        let mut connection = Connection::open_in_memory().unwrap();
        let failing: &[(i64, &str)] = &[(
            1,
            "CREATE TABLE workspace_state (id INTEGER PRIMARY KEY);
             INSERT INTO nonexistent_table VALUES (1);",
        )];

        let error = run_migrations(&mut connection, failing).unwrap_err();
        assert!(matches!(error, AppError::Database(_)));

        let tables = tables(&connection);
        assert!(!tables.contains(&"workspace_state".to_string()));
        let version: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 0);
    }

    #[test]
    fn database_handle_exposes_connection_through_narrow_interface() {
        let mut connection = Connection::open_in_memory().unwrap();
        run_migrations(&mut connection, MIGRATIONS).unwrap();
        let handle = DatabaseHandle::new(connection);

        let workspace_tables: Vec<String> = handle
            .with_connection(|connection| {
                let mut statement = connection.prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_state'",
                )?;
                let names = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(names)
            })
            .unwrap();

        assert_eq!(workspace_tables, vec!["workspace_state"]);
    }
}
