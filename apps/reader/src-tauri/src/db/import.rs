use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{classify_io_error, AppError};
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

    /// 把外部源文件全部字节流式复制到暂存区,计算完整内容指纹,并写入一条 pending 记录。
    /// 外部原文件只读,不会被修改或删除。stage 失败(复制中断)时不会写 pending,
    /// 残留的暂存文件由启动恢复器作为孤儿清理。
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
        self.connection.execute(
            "INSERT INTO materials (id, status, fingerprint, title, author, language, source_file_name)
             VALUES (?1, 'pending', ?2, '', NULL, NULL, ?3)",
            params![id, fingerprint, original_file_name],
        )?;
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

    /// 丢弃一份不再需要的暂存导入(检查失败或用户中止时调用)。删除 pending 记录并移除暂存文件。
    /// 幂等:暂存文件或记录不存在时不报错。
    pub fn discard(&self, staged: &StagedImport, paths: &LibraryPaths) -> Result<(), AppError> {
        self.connection
            .execute("DELETE FROM materials WHERE id = ?1", [&staged.id])?;
        let stash_path = paths.stash_path(&staged.id);
        if stash_path.is_file() {
            std::fs::remove_file(&stash_path).map_err(classify_io_error)?;
        }
        Ok(())
    }

    /// 读取已提交托管文件中某一本的原始字节,交给前端打开阅读。
    pub fn read_managed(&self, material_id: &str, paths: &LibraryPaths) -> Result<Vec<u8>, AppError> {
        if self.find_by_id(material_id)?.is_none() {
            return Err(AppError::ManagedFileMissing(material_id.to_string()));
        }
        let managed_path = paths.managed_path(material_id);
        if !managed_path.is_file() {
            return Err(AppError::ManagedFileMissing(material_id.to_string()));
        }
        read_file_bytes(&managed_path)
    }

    /// 提交导入:按 ready 状态指纹去重;去重命中则清理暂存与 pending 记录并返回既有材料;
    /// 否则移动托管文件并把 pending 记录升级为 ready。复用暂存 id 作为稳定 BookId,保证恢复、覆盖与应用升级中身份稳定。
    /// 顺序:先把来源元数据写入 pending 记录、再移动托管文件、最后置 ready。
    /// 若在移动与置 ready 之间异常终止,启动恢复器会基于「存在托管文件」这一事实完成该 pending,
    /// 且此时元数据已与暂存记录持久化,恢复出的材料不会缺失标题作者。
    pub fn commit(
        &self,
        staged: &StagedImport,
        metadata: &MaterialMetadata,
        paths: &LibraryPaths,
    ) -> Result<ReadingMaterial, AppError> {
        if let Some(existing) = self.find_ready_by_fingerprint(&staged.fingerprint)? {
            self.connection
                .execute("DELETE FROM materials WHERE id = ?1", [&staged.id])?;
            let _ = std::fs::remove_file(paths.stash_path(&staged.id));
            return Ok(existing);
        }

        self.connection.execute(
            "UPDATE materials SET title=?1, author=?2, language=?3 WHERE id = ?4",
            params![metadata.title, metadata.author, metadata.language, staged.id],
        )?;

        let managed_path = paths.managed_path(&staged.id);
        if let Err(error) = std::fs::rename(paths.stash_path(&staged.id), &managed_path) {
            // 移动失败说明暂存仍可回滚,清理已写入的 pending 元数据以保持一致性。
            let _ = self
                .connection
                .execute("DELETE FROM materials WHERE id = ?1", [&staged.id]);
            return Err(classify_io_error(error));
        }

        if let Err(error) = self.connection.execute(
            "UPDATE materials SET status='ready', updated_at=datetime('now')
             WHERE id = ?1",
            params![staged.id],
        ) {
            let _ = std::fs::remove_file(&managed_path);
            return Err(error.into());
        }

        Ok(ReadingMaterial {
            id: staged.id.clone(),
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

    /// 启动恢复:处理 pending 记录,并清理确认无主的暂存与托管文件。
    ///
    /// 对每条 pending 记录:
    /// - 若对应托管文件已存在 → 说明崩溃发生在「移动文件之后、置 ready 之前」,安全完成(置 ready)。
    /// - 否则 → 说明崩溃发生在暂存或检查阶段,回滚(删除 pending 记录与暂存文件)。
    ///
    /// 之后再清理没有任何数据库记录引用的孤儿暂存/托管文件。
    /// 绝不删除 ready 阅读材料或外部原文件。
    pub fn recover(&self, paths: &LibraryPaths) -> Result<(), AppError> {
        let pending_ids = self.list_pending_ids()?;
        for id in pending_ids {
            if paths.managed_path(&id).is_file() {
                self.connection.execute(
                    "UPDATE materials SET status='ready', updated_at=datetime('now') WHERE id = ?1",
                    [&id],
                )?;
                let _ = std::fs::remove_file(paths.stash_path(&id));
            } else {
                self.connection
                    .execute("DELETE FROM materials WHERE id = ?1", [&id])?;
                let _ = std::fs::remove_file(paths.stash_path(&id));
            }
        }

        for entry in std::fs::read_dir(&paths.stash_dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_file() && self.find_by_id(&file_name)?.is_none() {
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

    fn list_pending_ids(&self) -> Result<Vec<String>, AppError> {
        let mut statement =
            self.connection
                .prepare("SELECT id FROM materials WHERE status = 'pending'")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        Ok(ids)
    }

    fn find_ready_by_fingerprint(&self, fingerprint: &str) -> Result<Option<ReadingMaterial>, AppError> {
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
            .execute_batch(include_str!("migrations/0003_import_pending.sql"))
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
    fn discard_removes_staged_file() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"bytes");
        let staged = repository.stage(&source, &paths).unwrap();
        assert!(paths.stash_path(&staged.id).is_file());

        repository.discard(&staged, &paths).unwrap();

        assert!(!paths.stash_path(&staged.id).exists());
    }

    #[test]
    fn discard_is_idempotent_when_staged_file_already_gone() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let staged = StagedImport {
            id: "already-gone".to_string(),
            original_file_name: "book.epub".to_string(),
            fingerprint: "abc".to_string(),
        };

        repository.discard(&staged, &paths).unwrap();
    }

    #[test]
    fn stage_missing_source_surfaces_typed_io_error() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();

        let error = repository
            .stage(&paths.stash_dir.join("no-such.epub"), &paths)
            .unwrap_err();

        assert!(matches!(error, AppError::Io(_)));
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

        assert!(matches!(error, AppError::Io(_)));
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
    fn read_managed_missing_file_returns_typed_error() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();

        let error = repository.read_managed("no-such", &paths).unwrap_err();

        assert!(matches!(error, AppError::ManagedFileMissing(_)));
    }

    #[test]
    fn read_managed_returns_committed_bytes() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"managed-epub-bytes");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        let bytes = repository.read_managed(&material.id, &paths).unwrap();

        assert_eq!(bytes, b"managed-epub-bytes");
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

    #[test]
    fn stage_creates_pending_record_and_list_excludes_it() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"pending-bytes");
        let staged = repository.stage(&source, &paths).unwrap();

        let status: String = connection
            .query_row(
                "SELECT status FROM materials WHERE id = ?1",
                params![staged.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "pending");
        assert!(repository.list_materials().unwrap().is_empty());
    }

    #[test]
    fn recover_rolls_back_pending_without_managed_file() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"abandoned");
        let staged = repository.stage(&source, &paths).unwrap();
        assert!(paths.stash_path(&staged.id).is_file());

        repository.recover(&paths).unwrap();

        assert!(!paths.stash_path(&staged.id).exists());
        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM materials WHERE id = ?1",
                params![staged.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn recover_completes_pending_that_already_has_managed_file() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"crash-content");
        let staged = repository.stage(&source, &paths).unwrap();
        // 模拟崩溃发生在「移动文件之后、置 ready 之前」:托管文件已存在、元数据已写入 pending 记录。
        std::fs::rename(
            paths.stash_path(&staged.id),
            paths.managed_path(&staged.id),
        )
        .unwrap();
        connection
            .execute(
                "UPDATE materials SET title='崩溃书', author='作者', language='zh' WHERE id = ?1",
                [&staged.id],
            )
            .unwrap();

        repository.recover(&paths).unwrap();

        let row = repository.list_materials().unwrap().remove(0);
        assert_eq!(row.id, staged.id);
        assert_eq!(row.title, "崩溃书");
        assert_eq!(row.author.as_deref(), Some("作者"));
        assert!(paths.managed_path(&staged.id).is_file());
        assert!(!paths.stash_path(&staged.id).exists());
    }

    #[test]
    fn commit_dedup_removes_pending_record_of_duplicate_staged_import() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"dedup-content");
        let staged = repository.stage(&source, &paths).unwrap();
        let metadata = MaterialMetadata {
            title: "甲".to_string(),
            ..Default::default()
        };
        let first = repository.commit(&staged, &metadata, &paths).unwrap();

        let source2 = write_source(&paths, "copy.epub", b"dedup-content");
        let staged2 = repository.stage(&source2, &paths).unwrap();
        let second = repository.commit(&staged2, &metadata, &paths).unwrap();

        assert_eq!(second.id, first.id);
        let pending_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM materials WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending_count, 0);
    }

    #[test]
    fn recover_does_not_delete_ready_material_or_external_source() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let external = paths.stash_dir.join("..").join("external-source.epub");
        std::fs::write(&external, b"keep-me").unwrap();
        let staged = repository.stage(&external, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        repository.recover(&paths).unwrap();

        assert!(paths.managed_path(&material.id).is_file());
        assert_eq!(std::fs::read(&external).unwrap(), b"keep-me");
    }
}
