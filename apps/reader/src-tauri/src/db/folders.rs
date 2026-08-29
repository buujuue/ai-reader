use std::collections::{HashMap, HashSet};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, TransactionBehavior};
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderDeletionResult {
    pub deleted_folder_ids: Vec<String>,
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

    /// 递归删除文件夹子树,并在同一 SQLite 事务中清除活跃及回收站材料归属。
    /// 文件夹先按后序删除,以满足父级外键的 RESTRICT 约束;事务失败时两部分一起回滚。
    pub fn delete(&self, folder_id: &str) -> Result<LibraryFolderDeletionResult, AppError> {
        let transaction =
            rusqlite::Transaction::new_unchecked(self.connection, TransactionBehavior::Immediate)?;
        let deleted_folder_ids = Self::subtree_postorder(&transaction, folder_id)?;
        let placeholders = std::iter::repeat_n("?", deleted_folder_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        transaction.execute(
            &format!("UPDATE materials SET folder_id = NULL WHERE folder_id IN ({placeholders})"),
            params_from_iter(deleted_folder_ids.iter()),
        )?;
        for folder_id in &deleted_folder_ids {
            transaction.execute("DELETE FROM library_folders WHERE id = ?1", [folder_id])?;
        }
        transaction.commit()?;
        Ok(LibraryFolderDeletionResult { deleted_folder_ids })
    }

    fn subtree_postorder(
        connection: &Connection,
        folder_id: &str,
    ) -> Result<Vec<String>, AppError> {
        let mut statement = connection.prepare(
            "WITH RECURSIVE subtree(id, parent_id) AS (
                 SELECT id, parent_id FROM library_folders WHERE id = ?1
                 UNION
                 SELECT child.id, child.parent_id
                 FROM library_folders child
                 JOIN subtree parent ON child.parent_id = parent.id
             )
             SELECT id, parent_id FROM subtree",
        )?;
        let rows = statement
            .query_map([folder_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.is_empty() {
            return Err(AppError::LibraryFolderNotFound(folder_id.to_string()));
        }

        let mut children_by_parent: HashMap<String, Vec<String>> = HashMap::new();
        for (id, parent_id) in rows {
            if let Some(parent_id) = parent_id {
                children_by_parent.entry(parent_id).or_default().push(id);
            }
        }

        let mut ordered = Vec::new();
        let mut visited = HashSet::new();
        let mut visiting = HashSet::new();
        fn visit(
            folder_id: &str,
            children_by_parent: &HashMap<String, Vec<String>>,
            visiting: &mut HashSet<String>,
            visited: &mut HashSet<String>,
            ordered: &mut Vec<String>,
        ) -> Result<(), AppError> {
            if visited.contains(folder_id) {
                return Ok(());
            }
            if !visiting.insert(folder_id.to_string()) {
                return Err(AppError::LibraryFolderCycle);
            }
            if let Some(children) = children_by_parent.get(folder_id) {
                for child_id in children {
                    visit(child_id, children_by_parent, visiting, visited, ordered)?;
                }
            }
            visiting.remove(folder_id);
            visited.insert(folder_id.to_string());
            ordered.push(folder_id.to_string());
            Ok(())
        }
        visit(
            folder_id,
            &children_by_parent,
            &mut visiting,
            &mut visited,
            &mut ordered,
        )?;
        Ok(ordered)
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

    fn migrated_connection_with_materials() -> Connection {
        let connection = migrated_connection();
        connection
            .execute_batch(
                "CREATE TABLE materials (
                    id TEXT PRIMARY KEY NOT NULL,
                    folder_id TEXT REFERENCES library_folders(id) ON DELETE SET NULL,
                    deleted_at TEXT
                );",
            )
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

    #[test]
    fn deletes_deep_subtree_unfiles_active_and_trashed_materials_atomically() {
        let connection = migrated_connection_with_materials();
        let repository = LibraryFolderRepository::new(&connection);
        let root = repository.create("目标", None).unwrap();
        let child = repository.create("子级", Some(&root.id)).unwrap();
        let grandchild = repository.create("孙级", Some(&child.id)).unwrap();
        let sibling = repository.create("保留", None).unwrap();
        connection
            .execute(
                "INSERT INTO materials (id, folder_id, deleted_at)
                 VALUES ('active', ?1, NULL), ('trashed', ?2, 'now'), ('keep', ?3, NULL)",
                params![root.id, grandchild.id, sibling.id],
            )
            .unwrap();

        let result = repository.delete(&root.id).unwrap();

        assert_eq!(
            result.deleted_folder_ids,
            vec![grandchild.id.clone(), child.id.clone(), root.id.clone()]
        );
        assert_eq!(repository.list().unwrap(), vec![sibling.clone()]);
        let active_folder: Option<String> = connection
            .query_row(
                "SELECT folder_id FROM materials WHERE id = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let trashed_folder: Option<String> = connection
            .query_row(
                "SELECT folder_id FROM materials WHERE id = 'trashed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let kept_folder: Option<String> = connection
            .query_row(
                "SELECT folder_id FROM materials WHERE id = 'keep'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_folder, None);
        assert_eq!(trashed_folder, None);
        assert_eq!(kept_folder, Some(sibling.id));
    }

    #[test]
    fn deleting_missing_folder_does_not_mutate_materials_or_folders() {
        let connection = migrated_connection_with_materials();
        let repository = LibraryFolderRepository::new(&connection);
        let folder = repository.create("保留", None).unwrap();
        connection
            .execute(
                "INSERT INTO materials (id, folder_id) VALUES ('material', ?1)",
                [&folder.id],
            )
            .unwrap();

        assert!(matches!(
            repository.delete("missing"),
            Err(AppError::LibraryFolderNotFound(_))
        ));
        assert_eq!(repository.list().unwrap(), vec![folder.clone()]);
        let stored_folder: Option<String> = connection
            .query_row(
                "SELECT folder_id FROM materials WHERE id = 'material'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_folder, Some(folder.id));
    }

    #[test]
    fn delete_rolls_back_material_unfiling_when_folder_constraint_fails() {
        let connection = migrated_connection_with_materials();
        let repository = LibraryFolderRepository::new(&connection);
        let root = repository.create("目标", None).unwrap();
        let child = repository.create("子级", Some(&root.id)).unwrap();
        connection
            .execute(
                "INSERT INTO materials (id, folder_id) VALUES ('material', ?1)",
                [&root.id],
            )
            .unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TRIGGER prevent_child_delete
                 BEFORE DELETE ON library_folders
                 WHEN OLD.id = '{}'
                 BEGIN SELECT RAISE(ABORT, 'folder delete blocked'); END;",
                child.id
            ))
            .unwrap();

        assert!(repository.delete(&root.id).is_err());
        assert_eq!(repository.list().unwrap().len(), 2);
        let stored_folder: Option<String> = connection
            .query_row(
                "SELECT folder_id FROM materials WHERE id = 'material'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_folder, Some(root.id));
    }
}
