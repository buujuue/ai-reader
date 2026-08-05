use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::fs::{read_file_bytes, stream_copy_with_fingerprint, LibraryPaths};

/// Rust 暂存后的导入句柄。`id` 同时作为暂存文件名,TS 端据此读取字节检查格式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedImport {
    pub id: String,
    pub original_file_name: String,
    pub fingerprint: String,
}

/// TypeScript 端通过 BookDocument 检查后回传的来源元数据快照。serde 命名与 TS 一致(camelCase)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialMetadata {
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
}

/// 已提交的阅读材料领域对象。`id` 即稳定 BookId(UUID)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMaterial {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
    pub fingerprint: String,
    pub source_file_name: String,
}

/// 导入的 typed repository。采用 `stage → inspect → commit`:
/// Rust 负责暂存、指纹、落库与原子移动;TS 负责检查格式与提取元数据。
pub struct ImportRepository<'a> {
    connection: &'a Connection,
}

impl<'a> ImportRepository<'a> {
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    /// 把外部源文件全部字节流式复制到暂存区,并计算完整内容指纹。
    /// 外部原文件只读,不会被修改或删除。
    pub fn stage(
        &self,
        source_path: &Path,
        paths: &LibraryPaths,
    ) -> Result<StagedImport, AppError> {
        let id = uuid::Uuid::new_v4().to_string();
        let stash_path = paths.stash_path(&id);
        let fingerprint = stream_copy_with_fingerprint(source_path, &stash_path)?;
        let original_file_name = source_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(StagedImport {
            id,
            original_file_name,
            fingerprint,
        })
    }

    /// 读取暂存文件字节,交给 TypeScript 端检查格式与提取元数据。
    pub fn read_staged(
        &self,
        staged: &StagedImport,
        paths: &LibraryPaths,
    ) -> Result<Vec<u8>, AppError> {
        let stash_path = paths.stash_path(&staged.id);
        if !stash_path.is_file() {
            return Err(AppError::StagedFileMissing(staged.id.clone()));
        }
        read_file_bytes(&stash_path)
    }

    /// 提交导入:按指纹去重;去重命中则清理暂存并返回既有材料;
    /// 否则生成稳定 BookId、原子移动托管文件并写入 ready 记录。
    pub fn commit(
        &self,
        staged: &StagedImport,
        metadata: &MaterialMetadata,
        paths: &LibraryPaths,
    ) -> Result<ReadingMaterial, AppError> {
        if let Some(existing) = self.find_by_fingerprint(&staged.fingerprint)? {
            let _ = std::fs::remove_file(paths.stash_path(&staged.id));
            return Ok(existing);
        }

        let id = uuid::Uuid::new_v4().to_string();
        let managed_path = paths.managed_path(&id);
        std::fs::rename(paths.stash_path(&staged.id), &managed_path)
            .map_err(|source| AppError::ImportCommit(source.to_string()))?;

        if let Err(error) = self.connection.execute(
            "INSERT INTO materials (id, status, fingerprint, title, author, language, source_file_name)
             VALUES (?1, 'ready', ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                staged.fingerprint,
                metadata.title,
                metadata.author,
                metadata.language,
                staged.original_file_name
            ],
        ) {
            let _ = std::fs::remove_file(&managed_path);
            return Err(error.into());
        }

        Ok(ReadingMaterial {
            id,
            title: metadata.title.clone(),
            author: metadata.author.clone(),
            language: metadata.language.clone(),
            fingerprint: staged.fingerprint.clone(),
            source_file_name: staged.original_file_name.clone(),
        })
    }

    /// 列出活跃书库中的阅读材料。
    pub fn list_materials(&self) -> Result<Vec<ReadingMaterial>, AppError> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, author, language, fingerprint, source_file_name
             FROM materials WHERE status = 'ready' ORDER BY created_at",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ReadingMaterial {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                language: row.get(3)?,
                fingerprint: row.get(4)?,
                source_file_name: row.get(5)?,
            })
        })?;
        let mut materials = Vec::new();
        for row in rows {
            materials.push(row?);
        }
        Ok(materials)
    }

    /// 启动恢复:清空暂存目录,并移除没有数据库记录的孤儿托管文件。
    /// 崩溃若发生在移动与落库之间,此函数保证不残留半本书或半条记录。
    pub fn recover(&self, paths: &LibraryPaths) -> Result<(), AppError> {
        for entry in std::fs::read_dir(&paths.stash_dir)? {
            let entry = entry?;
            if entry.path().is_file() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        for entry in std::fs::read_dir(&paths.managed_dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_file() && self.find_by_id(&file_name)?.is_none() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    fn find_by_fingerprint(&self, fingerprint: &str) -> Result<Option<ReadingMaterial>, AppError> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, author, language, fingerprint, source_file_name
             FROM materials
             WHERE fingerprint = ?1 AND status = 'ready'
             LIMIT 1",
        )?;
        let mut rows = statement.query(params![fingerprint])?;
        match rows.next()? {
            Some(row) => Ok(Some(ReadingMaterial {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                language: row.get(3)?,
                fingerprint: row.get(4)?,
                source_file_name: row.get(5)?,
            })),
            None => Ok(None),
        }
    }

    fn find_by_id(&self, id: &str) -> Result<Option<ReadingMaterial>, AppError> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, author, language, fingerprint, source_file_name
             FROM materials WHERE id = ?1 LIMIT 1",
        )?;
        let mut rows = statement.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(ReadingMaterial {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                language: row.get(3)?,
                fingerprint: row.get(4)?,
                source_file_name: row.get(5)?,
            })),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn migrated_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("migrations/0002_materials.sql"))
            .unwrap();
        connection
    }

    fn temp_paths() -> LibraryPaths {
        let dir =
            std::env::temp_dir().join(format!("ai-reader-import-test-{}", uuid::Uuid::new_v4()));
        LibraryPaths::new(&dir).unwrap()
    }

    fn write_source(paths: &LibraryPaths, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let source = paths.stash_dir.join(name);
        std::fs::write(&source, bytes).unwrap();
        source
    }

    #[test]
    fn stage_copies_all_bytes_and_computes_fingerprint_without_touching_source() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"epub-bytes");

        let staged = repository.stage(&source, &paths).unwrap();

        assert_eq!(staged.original_file_name, "book.epub");
        assert_eq!(
            std::fs::read(paths.stash_path(&staged.id)).unwrap(),
            b"epub-bytes"
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"epub-bytes");
        assert_eq!(
            staged.fingerprint,
            stream_copy_with_fingerprint(&source, &paths.managed_dir.join("probe")).unwrap()
        );
    }

    #[test]
    fn read_staged_returns_the_staged_bytes() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"content");
        let staged = repository.stage(&source, &paths).unwrap();

        let bytes = repository.read_staged(&staged, &paths).unwrap();

        assert_eq!(bytes, b"content");
    }

    #[test]
    fn read_staged_missing_file_returns_typed_error() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let staged = StagedImport {
            id: "missing".to_string(),
            original_file_name: "book.epub".to_string(),
            fingerprint: "abc".to_string(),
        };

        let error = repository.read_staged(&staged, &paths).unwrap_err();

        assert!(matches!(error, AppError::StagedFileMissing(_)));
    }

    #[test]
    fn commit_moves_file_to_managed_library_writes_ready_record_and_keeps_source() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"epub-content");
        let staged = repository.stage(&source, &paths).unwrap();
        let metadata = MaterialMetadata {
            title: "示例书".to_string(),
            author: Some("作者".to_string()),
            language: Some("zh".to_string()),
        };

        let material = repository.commit(&staged, &metadata, &paths).unwrap();

        assert!(!material.id.is_empty());
        assert_eq!(material.title, "示例书");
        assert_eq!(material.author.as_deref(), Some("作者"));
        assert_eq!(material.language.as_deref(), Some("zh"));

        assert!(paths.managed_path(&material.id).is_file());
        assert_eq!(
            std::fs::read(paths.managed_path(&material.id)).unwrap(),
            b"epub-content"
        );
        assert!(!paths.stash_path(&staged.id).exists());
        assert_eq!(std::fs::read(&source).unwrap(), b"epub-content");

        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM materials WHERE id = ?1", params![material.id], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn commit_dedupes_same_fingerprint_returns_existing_material() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"same-content");
        let staged = repository.stage(&source, &paths).unwrap();
        let metadata = MaterialMetadata {
            title: "示例书".to_string(),
            ..Default::default()
        };
        let first = repository.commit(&staged, &metadata, &paths).unwrap();

        let source2 = write_source(&paths, "copy.epub", b"same-content");
        let staged2 = repository.stage(&source2, &paths).unwrap();
        let second = repository.commit(&staged2, &metadata, &paths).unwrap();

        assert_eq!(second.id, first.id);
        assert!(!paths.stash_path(&staged2.id).exists());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM materials", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_then_commit_missing_staged_file_returns_error() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let staged = StagedImport {
            id: "nope".to_string(),
            original_file_name: "book.epub".to_string(),
            fingerprint: "abc".to_string(),
        };

        let error = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap_err();

        assert!(matches!(error, AppError::ImportCommit(_)));
    }

    #[test]
    fn list_materials_returns_committed_materials_in_order() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        for (name, bytes, title) in [
            ("a.epub", b"aaa", "甲"),
            ("b.epub", b"bbb", "乙"),
        ] {
            let source = write_source(&paths, name, bytes);
            let staged = repository.stage(&source, &paths).unwrap();
            let metadata = MaterialMetadata {
                title: title.to_string(),
                ..Default::default()
            };
            repository.commit(&staged, &metadata, &paths).unwrap();
        }

        let materials = repository.list_materials().unwrap();

        assert_eq!(materials.len(), 2);
        assert_eq!(materials[0].title, "甲");
        assert_eq!(materials[1].title, "乙");
    }

    #[test]
    fn recover_cleans_orphaned_stash_and_managed_files() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        std::fs::write(paths.stash_path("orphan"), b"x").unwrap();
        std::fs::write(paths.managed_path("no-row"), b"y").unwrap();

        repository.recover(&paths).unwrap();

        assert!(!paths.stash_path("orphan").exists());
        assert!(!paths.managed_path("no-row").exists());
    }

    #[test]
    fn recover_keeps_managed_file_that_has_a_database_record() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"content");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();
        std::fs::write(paths.stash_path("orphan"), b"x").unwrap();

        repository.recover(&paths).unwrap();

        assert!(paths.managed_path(&material.id).is_file());
        assert!(!paths.stash_path("orphan").exists());
    }
}
