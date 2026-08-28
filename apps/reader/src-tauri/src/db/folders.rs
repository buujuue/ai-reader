use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub const MAX_LIBRARY_FOLDER_DEPTH: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
}

pub struct LibraryFolderRepository<'a> {
    connection: &'a Connection,
}

impl<'a> LibraryFolderRepository<'a> {
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    pub fn list(&self) -> Result<Vec<LibraryFolder>, AppError> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, parent_id
             FROM library_folders
             ORDER BY name_key ASC, id ASC",
        )?;
        let folders = statement
            .query_map([], |row| {
                Ok(LibraryFolder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(folders)
    }

    pub fn create(&self, name: &str, parent_id: Option<&str>) -> Result<LibraryFolder, AppError> {
        let normalized = normalize_name(name)?;
        if let Some(parent_id) = parent_id {
            let depth = self.folder_depth(parent_id)?;
            if depth >= MAX_LIBRARY_FOLDER_DEPTH {
                return Err(AppError::LibraryFolderDepthExceeded);
            }
        }
        self.ensure_name_available(&normalized, parent_id, None)?;

        let folder = LibraryFolder {
            id: uuid::Uuid::new_v4().to_string(),
            name: normalized,
            parent_id: parent_id.map(ToOwned::to_owned),
        };
        self.connection.execute(
            "INSERT INTO library_folders (id, name, name_key, parent_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                folder.id,
                folder.name,
                folder.name.to_lowercase(),
                folder.parent_id,
            ],
        )?;
        Ok(folder)
    }

    pub fn rename(&self, folder_id: &str, name: &str) -> Result<LibraryFolder, AppError> {
        let current = self.find(folder_id)?;
        let normalized = normalize_name(name)?;
        self.ensure_name_available(&normalized, current.parent_id.as_deref(), Some(folder_id))?;
        self.connection.execute(
            "UPDATE library_folders
             SET name = ?1, name_key = ?2
             WHERE id = ?3",
            params![normalized, normalized.to_lowercase(), folder_id],
        )?;
        Ok(LibraryFolder {
            id: current.id,
            name: normalized,
            parent_id: current.parent_id,
        })
    }

    fn find(&self, folder_id: &str) -> Result<LibraryFolder, AppError> {
        self.connection
            .query_row(
                "SELECT id, name, parent_id FROM library_folders WHERE id = ?1",
                [folder_id],
                |row| {
                    Ok(LibraryFolder {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        parent_id: row.get(2)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::LibraryFolderNotFound(folder_id.to_string()))
    }

    fn folder_depth(&self, folder_id: &str) -> Result<usize, AppError> {
        let mut current_id = folder_id.to_string();
        let mut depth = 1;
        let mut visited = HashSet::new();
        loop {
            if !visited.insert(current_id.clone()) {
                return Err(AppError::LibraryFolderCycle);
            }
            let parent_id: Option<String> = self
                .connection
                .query_row(
                    "SELECT parent_id FROM library_folders WHERE id = ?1",
                    [&current_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| AppError::LibraryFolderParentNotFound(current_id.clone()))?;
            match parent_id {
                Some(parent_id) => {
                    current_id = parent_id;
                    depth += 1;
                }
                None => return Ok(depth),
            }
        }
    }

    fn ensure_name_available(
        &self,
        name: &str,
        parent_id: Option<&str>,
        excluded_id: Option<&str>,
    ) -> Result<(), AppError> {
        let name_key = name.to_lowercase();
        let conflict = self
            .connection
            .query_row(
                "SELECT id FROM library_folders
                 WHERE name_key = ?1
                   AND ((parent_id IS NULL AND ?2 IS NULL) OR parent_id = ?2)
                   AND (?3 IS NULL OR id <> ?3)
                 LIMIT 1",
                params![name_key, parent_id, excluded_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if conflict.is_some() {
            return Err(AppError::LibraryFolderNameConflict(name.to_string()));
        }
        Ok(())
    }
}

fn normalize_name(name: &str) -> Result<String, AppError> {
    if name.chars().any(char::is_control) {
        return Err(AppError::InvalidLibraryFolderName(
            "文件夹名称不能包含控制字符,请删除不可见字符".to_string(),
        ));
    }
    let normalized = name.trim();
    if normalized.is_empty() {
        return Err(AppError::InvalidLibraryFolderName(
            "文件夹名称不能为空,请输入名称".to_string(),
        ));
    }
    if normalized.chars().count() > 80 {
        return Err(AppError::InvalidLibraryFolderName(
            "文件夹名称最多 80 个字符,请缩短名称".to_string(),
        ));
    }
    if normalized.contains('/') || normalized.contains('\\') {
        return Err(AppError::InvalidLibraryFolderName(
            "文件夹名称不能包含路径分隔符,请使用普通名称".to_string(),
        ));
    }
    Ok(normalized.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("migrations/0010_library_folders.sql"))
            .unwrap();
        connection
    }

    #[test]
    fn creates_and_lists_stable_folder_tree() {
        let connection = migrated_connection();
        let repository = LibraryFolderRepository::new(&connection);
        let root = repository.create("  阅读  ", None).unwrap();
        let child = repository.create("章节", Some(&root.id)).unwrap();

        assert_eq!(
            repository.list().unwrap(),
            vec![child.clone(), root.clone()]
        );
    }

    #[test]
    fn rejects_invalid_names_duplicates_and_sixth_level() {
        let connection = migrated_connection();
        let repository = LibraryFolderRepository::new(&connection);
        let root = repository.create("阅读", None).unwrap();
        assert!(matches!(
            repository.create("阅读", None),
            Err(AppError::LibraryFolderNameConflict(_))
        ));
        assert!(matches!(
            repository.create("a/b", None),
            Err(AppError::InvalidLibraryFolderName(_))
        ));
        assert!(matches!(
            repository.create("a\n", None),
            Err(AppError::InvalidLibraryFolderName(_))
        ));
        assert!(matches!(
            repository.create(&"a".repeat(81), None),
            Err(AppError::InvalidLibraryFolderName(_))
        ));

        let mut parent = root.id;
        for depth in 2..=5 {
            parent = repository
                .create(&format!("第{depth}层"), Some(&parent))
                .unwrap()
                .id;
        }
        assert!(matches!(
            repository.create("第六层", Some(&parent)),
            Err(AppError::LibraryFolderDepthExceeded)
        ));
    }

    #[test]
    fn allows_same_name_under_different_parents_and_rejects_case_insensitive_siblings() {
        let connection = migrated_connection();
        let repository = LibraryFolderRepository::new(&connection);
        let first = repository.create("第一组", None).unwrap();
        let second = repository.create("第二组", None).unwrap();

        repository.create("Science", Some(&first.id)).unwrap();
        assert!(matches!(
            repository.create("science", Some(&first.id)),
            Err(AppError::LibraryFolderNameConflict(_))
        ));
        repository.create("Ä", Some(&first.id)).unwrap();
        assert!(matches!(
            repository.create("ä", Some(&first.id)),
            Err(AppError::LibraryFolderNameConflict(_))
        ));
        repository.create("science", Some(&second.id)).unwrap();
    }

    #[test]
    fn rename_keeps_parent_and_rejects_sibling_conflict() {
        let connection = migrated_connection();
        let repository = LibraryFolderRepository::new(&connection);
        let parent = repository.create("父级", None).unwrap();
        let child = repository.create("旧名", Some(&parent.id)).unwrap();
        repository.create("已占用", Some(&parent.id)).unwrap();

        let renamed = repository.rename(&child.id, " 新名 ").unwrap();
        assert_eq!(renamed.parent_id, Some(parent.id));
        assert!(matches!(
            repository.rename(&child.id, "已占用"),
            Err(AppError::LibraryFolderNameConflict(_))
        ));
    }
}
