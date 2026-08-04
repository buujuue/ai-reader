pub mod workspace;

use std::path::Path;

use rusqlite::Connection;

use crate::error::AppError;

const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("migrations/0001_workspace.sql"))];

/// 打开数据库连接并应用全部迁移。
/// SQLite 连接、迁移与 pragma 规则由 Rust 独占,TS 不接触数据库路径与 SQL。
pub fn open_database(path: &Path) -> Result<Connection, AppError> {
    let mut connection = Connection::open(path)?;
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
    connection: std::sync::Mutex<Connection>,
}

impl DatabaseHandle {
    pub fn new(connection: Connection) -> Self {
        Self {
            connection: std::sync::Mutex::new(connection),
        }
    }

    pub fn with_connection<T>(
        &self,
        action: impl FnOnce(&Connection) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| AppError::DatabaseLocked)?;
        action(&connection)
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
        assert_eq!(version, 1);
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
