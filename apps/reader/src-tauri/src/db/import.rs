use std::path::{Path, PathBuf};

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::db::annotations::{Annotation, AnnotationRepository};
use crate::error::{classify_io_error, AppError};
use crate::fs::{
    atomic_copy, atomic_copy_replace, atomic_write, fingerprint_bytes, fingerprint_file,
    read_file_bytes, read_file_range, stream_copy_with_fingerprint, LibraryPaths,
};

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

/// TS 侧生成的受控封面缩略图。Rust 不参与 EPUB 封面选择，只负责落盘。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCover {
    pub bytes: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverPayload {
    pub bytes: String,
    pub mime_type: String,
}

/// 托管材料范围读取的同步元数据。正文仍通过 read_managed_range 按需读取。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFileInfo {
    pub name: String,
    pub size: u64,
}

/// 用户确认后的显式 EPUB 版本迁移载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMigrationCommitRequest {
    pub material_id: String,
    pub staged: StagedImport,
    pub metadata: MaterialMetadata,
    #[serde(default)]
    pub source_cover: Option<SourceCover>,
    pub expected_source_fingerprint: String,
    pub expected_target_fingerprint: String,
    pub annotations: Vec<Annotation>,
    pub workspace_state: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMigrationCommitResult {
    pub material: ReadingMaterial,
    pub snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMigrationSnapshot {
    pub id: String,
    pub material_id: String,
    pub source_fingerprint: String,
    pub target_fingerprint: String,
    pub created_at: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMigrationRestoreResult {
    pub material: ReadingMaterial,
    pub annotations: Vec<Annotation>,
    pub workspace_state: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionMigrationManifest {
    id: String,
    material_id: String,
    source_fingerprint: String,
    target_fingerprint: String,
    created_at: i64,
    phase: String,
}

/// 不可编辑来源元数据快照(取自 materials 表列,整理操作永不改写)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
}

/// 用户覆盖值(独立数据,存于 material_overrides 表)。字段为 None 表示清除该覆盖并回落来源。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialOverride {
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover_source: Option<String>,
}

/// 已提交的阅读材料领域对象。`id` 即稳定 BookId(UUID)。
/// `source` 为不可编辑来源快照,`override` 为覆盖值,`title/author/language/cover_source` 为有效元数据(覆盖优先、来源兜底)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMaterial {
    pub id: String,
    pub fingerprint: String,
    pub source_file_name: String,
    pub source: SourceMetadata,
    #[serde(rename = "override")]
    pub user_override: MaterialOverride,
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
    pub cover_source: Option<String>,
    pub source_cover_source: Option<String>,
    /// 材料文档版本:正式保存 Markdown 时递增(EPUB/PDF 内容不可变,保持 0)。
    pub document_version: i64,
    /// 托管副本是否存在;缺失时保留数据库中的材料与用户数据。
    pub managed_file_available: bool,
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
        let format = format_from_file_name(&original_file_name);
        self.connection.execute(
            "INSERT INTO materials (id, status, fingerprint, format, title, author, language, source_file_name)
             VALUES (?1, 'pending', ?2, ?3, '', NULL, NULL, ?4)",
            params![id, fingerprint, format, original_file_name],
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
        let status: Option<String> = self
            .connection
            .query_row(
                "SELECT status FROM materials WHERE id = ?1",
                [&staged.id],
                |row| row.get(0),
            )
            .optional()?;
        let deleted = self.connection.execute(
            "DELETE FROM materials WHERE id = ?1 AND status = 'pending'",
            [&staged.id],
        )?;
        let stash_path = paths.stash_path(&staged.id);
        if (deleted > 0 || status.is_none()) && stash_path.is_file() {
            std::fs::remove_file(&stash_path).map_err(classify_io_error)?;
        }
        Ok(())
    }

    /// 返回活跃托管材料的名称与字节长度，不暴露内部路径。
    pub fn managed_file_info(
        &self,
        material_id: &str,
        paths: &LibraryPaths,
    ) -> Result<ManagedFileInfo, AppError> {
        self.ensure_active(material_id)?;
        let material = self
            .find_by_id(material_id)?
            .ok_or_else(|| AppError::MaterialNotFound(material_id.to_string()))?;
        let managed_path = self.managed_file_path(material_id, paths)?;
        let size = std::fs::metadata(&managed_path)
            .map_err(classify_io_error)?
            .len();
        Ok(ManagedFileInfo {
            name: material.source_file_name,
            size,
        })
    }

    /// 按半开区间读取活跃托管材料，不接受前端路径。
    pub fn read_managed_range(
        &self,
        material_id: &str,
        offset: u64,
        length: u64,
        paths: &LibraryPaths,
    ) -> Result<Vec<u8>, AppError> {
        self.ensure_active(material_id)?;
        let managed_path = self.managed_file_path(material_id, paths)?;
        read_file_range(&managed_path, offset, length)
    }

    /// 返回已提交托管文件的内部路径,只供 Rust 原生机械读取使用。
    /// 路径不跨 typed Command 边界,前端仍只使用稳定 BookId。
    pub fn managed_file_path(
        &self,
        material_id: &str,
        paths: &LibraryPaths,
    ) -> Result<std::path::PathBuf, AppError> {
        let mut components = Path::new(material_id).components();
        let is_single_normal_component =
            matches!(components.next(), Some(std::path::Component::Normal(_)))
                && components.next().is_none();
        if material_id.is_empty() || !is_single_normal_component {
            return Err(AppError::InvalidMaterialId(material_id.to_string()));
        }
        if self.find_by_id(material_id)?.is_none() {
            return Err(AppError::ManagedFileMissing(material_id.to_string()));
        }
        let managed_path = paths.managed_path(material_id);
        if !managed_path.is_file() {
            return Err(AppError::ManagedFileMissing(material_id.to_string()));
        }
        let managed_root = std::fs::canonicalize(&paths.managed_dir).map_err(classify_io_error)?;
        let canonical_path = std::fs::canonicalize(&managed_path).map_err(classify_io_error)?;
        if canonical_path.parent() != Some(managed_root.as_path()) {
            return Err(AppError::ManagedFileMissing(material_id.to_string()));
        }
        Ok(canonical_path)
    }

    /// 正式保存 Markdown 内容(ADR-0009):用托管文件原子替换、递增文档版本并更新
    /// 完整内容指纹,BookId 保持不变。TS 端不直接写文件,只调用本命令。
    ///
    /// 先在 IMMEDIATE 事务内检查新指纹是否与其它材料冲突,再原子写入托管文件
    /// 并更新指纹与版本。数据库写入失败时恢复旧文件,避免文件与记录分叉。
    pub fn save_markdown(
        &self,
        id: &str,
        content: &str,
        paths: &LibraryPaths,
    ) -> Result<ReadingMaterial, AppError> {
        self.ensure_ready(id)?;
        let current = self
            .find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))?;
        let managed_path = paths.managed_path(id);
        let fingerprint = fingerprint_bytes(content.as_bytes());
        let format = format_from_file_name(&current.source_file_name);
        let previous_bytes = read_file_bytes(&managed_path)?;
        let transaction =
            rusqlite::Transaction::new_unchecked(self.connection, TransactionBehavior::Immediate)?;
        let duplicate_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM materials
                 WHERE status = 'ready' AND fingerprint = ?1 AND format = ?2 AND id <> ?3
                 LIMIT 1",
                params![fingerprint, format, id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(duplicate_id) = duplicate_id {
            return Err(AppError::DuplicateMaterial(duplicate_id));
        }
        atomic_write(&managed_path, content.as_bytes())?;
        if let Err(error) = transaction.execute(
            "UPDATE materials
             SET fingerprint = ?1, document_version = document_version + 1, updated_at = datetime('now')
             WHERE id = ?2 AND status = 'ready'",
            params![fingerprint, id],
        ) {
            let _ = transaction.rollback();
            atomic_write(&managed_path, &previous_bytes)?;
            return Err(error.into());
        }
        if let Err(error) = transaction.commit() {
            // commit 错误可能发生在 SQLite 已完成提交之后。先读取落盘状态:
            // 已是新指纹就保留新文件,确认仍是旧指纹才恢复旧文件。
            if let Ok(persisted_fingerprint) = self
                .connection
                .query_row(
                    "SELECT fingerprint FROM materials WHERE id = ?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            {
                if persisted_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                    atomic_write(&managed_path, &previous_bytes)?;
                }
            }
            return Err(error.into());
        }
        self.find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))
    }

    /// 显式提交 EPUB 版本迁移。
    ///
    /// 快照先用 SQLite Online Backup 生成一致数据库副本并复制旧 EPUB。随后在
    /// IMMEDIATE 事务中校验旧/新完整指纹、原子替换托管文件、更新材料来源元数据、
    /// 批注和工作区状态。文件替换失败或事务失败都会把旧文件写回;快照目录持续保留,
    /// 供用户显式恢复或清除。
    pub fn commit_version_migration(
        &self,
        request: &VersionMigrationCommitRequest,
        paths: &LibraryPaths,
    ) -> Result<VersionMigrationCommitResult, AppError> {
        if format_from_file_name(&request.staged.original_file_name) != "epub" {
            return Err(AppError::BackupValidation(
                "只有 EPUB 支持显式版本迁移".to_string(),
            ));
        }
        let current = self
            .find_by_id(&request.material_id)?
            .ok_or_else(|| AppError::MaterialNotFound(request.material_id.clone()))?;
        if current.fingerprint != request.expected_source_fingerprint {
            return Err(AppError::BackupSourceChanged(request.material_id.clone()));
        }
        if request.staged.fingerprint != request.expected_target_fingerprint {
            return Err(AppError::StagedFileMissing(request.staged.id.clone()));
        }

        let staged_path = paths.stash_path(&request.staged.id);
        if !staged_path.is_file() || fingerprint_file(&staged_path)? != request.expected_target_fingerprint {
            return Err(AppError::StagedFileMissing(request.staged.id.clone()));
        }
        let pending = self
            .connection
            .query_row(
                "SELECT status, fingerprint, format, source_file_name
                 FROM materials WHERE id = ?1",
                [&request.staged.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((status, fingerprint, format, source_file_name)) = pending else {
            return Err(AppError::StagedFileMissing(request.staged.id.clone()));
        };
        if status != "pending"
            || fingerprint != request.expected_target_fingerprint
            || format != "epub"
            || source_file_name != request.staged.original_file_name
        {
            return Err(AppError::StagedFileMissing(request.staged.id.clone()));
        }

        let duplicate: Option<String> = self
            .connection
            .query_row(
                "SELECT id FROM materials
                 WHERE status = 'ready' AND fingerprint = ?1 AND format = 'epub'
                   AND id <> ?2 LIMIT 1",
                params![request.expected_target_fingerprint, request.material_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = duplicate {
            return Err(AppError::DuplicateMaterial(id));
        }

        let snapshot_id = self.create_version_migration_snapshot(
            &request.material_id,
            &request.expected_source_fingerprint,
            &request.expected_target_fingerprint,
            paths,
        )?;
        let snapshot_path = paths.version_migration_path(&snapshot_id)?;
        let managed_path = paths.managed_path(&request.material_id);
        let source_cover_path = paths.source_cover_path(&request.material_id);
        let transaction = match rusqlite::Transaction::new_unchecked(
            self.connection,
            TransactionBehavior::Immediate,
        ) {
            Ok(transaction) => transaction,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&snapshot_path);
                return Err(error.into());
            }
        };

        if let Err(error) = atomic_copy(&staged_path, &managed_path)
            .and_then(|_| {
                if let Some(source_cover) = request.source_cover.as_ref() {
                    write_source_cover(&request.material_id, source_cover, paths)?;
                } else if source_cover_path.is_file() {
                    std::fs::remove_file(&source_cover_path).map_err(classify_io_error)?;
                }
                transaction.execute(
                    "UPDATE materials
                     SET fingerprint = ?1, title = ?2, author = ?3, language = ?4,
                         source_file_name = ?5,
                         updated_at = datetime('now')
                     WHERE id = ?6 AND status = 'ready' AND fingerprint = ?7",
                    params![
                        request.expected_target_fingerprint,
                        request.metadata.title,
                        request.metadata.author,
                        request.metadata.language,
                        request.staged.original_file_name,
                        request.material_id,
                        request.expected_source_fingerprint,
                    ],
                )?;
                transaction.execute(
                    "DELETE FROM annotations WHERE material_id = ?1",
                    [&request.material_id],
                )?;
                AnnotationRepository::new(&transaction)
                    .save_many_in_transaction(&request.annotations)?;
                let workspace_json = serde_json::to_string(&request.workspace_state)
                    .map_err(AppError::WorkspaceStateSerialize)?;
                transaction.execute(
                    "INSERT INTO workspace_state (id, json, updated_at)
                     VALUES (1, ?1, datetime('now'))
                     ON CONFLICT(id) DO UPDATE SET
                        json = excluded.json, updated_at = excluded.updated_at",
                    [&workspace_json],
                )?;
                transaction.execute(
                    "DELETE FROM materials WHERE id = ?1 AND status = 'pending'",
                    [&request.staged.id],
                )?;
                transaction.commit().map_err(AppError::from)
            })
        {
            let _ = atomic_copy(&snapshot_path.join("material.epub"), &managed_path);
            let _ = restore_version_migration_source_cover(&snapshot_path, &source_cover_path);
            let _ = std::fs::remove_dir_all(&snapshot_path);
            return Err(error);
        }

        let mut manifest = read_version_migration_manifest(&snapshot_path)?;
        manifest.phase = "completed".to_string();
        write_version_migration_manifest(&snapshot_path, &manifest)?;
        let _ = std::fs::remove_file(staged_path);
        let material = self
            .find_by_id(&request.material_id)?
            .ok_or_else(|| AppError::MaterialNotFound(request.material_id.clone()))?;
        Ok(VersionMigrationCommitResult { material, snapshot_id })
    }

    /// 列出仍保留在应用私有目录中的迁移快照;损坏目录不被静默删除。
    pub fn list_version_migration_snapshots(
        &self,
        paths: &LibraryPaths,
    ) -> Result<Vec<VersionMigrationSnapshot>, AppError> {
        let mut snapshots = Vec::new();
        for entry in std::fs::read_dir(&paths.version_migration_dir).map_err(classify_io_error)? {
            let entry = entry.map_err(classify_io_error)?;
            if !entry.path().is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            let snapshot = match read_version_migration_manifest(&entry.path()) {
                Ok(manifest) => VersionMigrationSnapshot {
                    id: manifest.id,
                    material_id: manifest.material_id,
                    source_fingerprint: manifest.source_fingerprint,
                    target_fingerprint: manifest.target_fingerprint,
                    created_at: manifest.created_at,
                    status: if manifest.phase == "completed" {
                        "available".to_string()
                    } else {
                        "corrupt".to_string()
                    },
                },
                Err(_) => VersionMigrationSnapshot {
                    id,
                    material_id: String::new(),
                    source_fingerprint: String::new(),
                    target_fingerprint: String::new(),
                    created_at: 0,
                    status: "corrupt".to_string(),
                },
            };
            snapshots.push(snapshot);
        }
        snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.created_at));
        Ok(snapshots)
    }

    /// 用户明确清除一份迁移恢复快照;不会影响当前材料。
    pub fn clear_version_migration_snapshot(
        &self,
        snapshot_id: &str,
        paths: &LibraryPaths,
    ) -> Result<(), AppError> {
        let path = paths.version_migration_path(snapshot_id)?;
        match std::fs::remove_dir_all(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(classify_io_error(error)),
        }
    }

    fn create_version_migration_snapshot(
        &self,
        material_id: &str,
        source_fingerprint: &str,
        target_fingerprint: &str,
        paths: &LibraryPaths,
    ) -> Result<String, AppError> {
        let managed_path = paths.managed_path(material_id);
        if !managed_path.is_file() || fingerprint_file(&managed_path)? != source_fingerprint {
            return Err(AppError::ManagedFileMissing(material_id.to_string()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let temp_path = paths.version_migration_dir.join(format!(".{id}.tmp"));
        let final_path = paths.version_migration_path(&id)?;
        std::fs::create_dir_all(&temp_path).map_err(classify_io_error)?;
        let result = (|| {
            self.connection
                .backup("main", temp_path.join("database.sqlite"), None)?;
            atomic_copy(&managed_path, &temp_path.join("material.epub"))?;
            let source_cover_path = paths.source_cover_path(material_id);
            if source_cover_path.is_file() {
                atomic_copy(&source_cover_path, &temp_path.join("source-cover"))?;
            }
            let manifest = VersionMigrationManifest {
                id: id.clone(),
                material_id: material_id.to_string(),
                source_fingerprint: source_fingerprint.to_string(),
                target_fingerprint: target_fingerprint.to_string(),
                created_at: now_millis(),
                phase: "prepared".to_string(),
            };
            write_version_migration_manifest(&temp_path, &manifest)?;
            std::fs::rename(&temp_path, &final_path).map_err(classify_io_error)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&temp_path);
        }
        result.map(|_| id)
    }

    /// 提交导入:按 `完整指纹 + 格式` 查重;去重命中则在数据库事务中清理
    /// 当前 pending 并返回既有材料;缺失或损坏的既有托管副本会先原子恢复,
    /// 保持原 BookId,元数据和用户数据不变。
    ///
    /// 新材料的数据库状态与文件移动由一个可恢复协议连接:
    /// 1. 先把来源元数据写入 pending,保证中断恢复不会丢失预检结果;
    /// 2. 以 IMMEDIATE 事务锁住同一书库的其它提交者,把暂存文件移动到 UUID 托管路径;
    /// 3. 只有移动成功后才把 pending 升为 ready 并提交事务。
    ///
    /// SQLite 事务与文件系统不能组成一个跨系统事务。进程若在文件移动和
    /// SQLite 提交之间中断,启动恢复会核对文件指纹;不匹配就删除 pending 和
    /// 半成品,匹配则完成提交。因此 ready 记录不会依赖外部源文件路径。
    #[allow(dead_code)]
    pub fn commit(
        &self,
        staged: &StagedImport,
        metadata: &MaterialMetadata,
        paths: &LibraryPaths,
    ) -> Result<ReadingMaterial, AppError> {
        self.commit_with_source_cover(staged, metadata, paths, None)
    }

    /// 提交时可选写入 TS 已生成的来源封面;自定义封面不会被覆盖。
    pub fn commit_with_source_cover(
        &self,
        staged: &StagedImport,
        metadata: &MaterialMetadata,
        paths: &LibraryPaths,
        source_cover: Option<&SourceCover>,
    ) -> Result<ReadingMaterial, AppError> {
        let format = format_from_file_name(&staged.original_file_name);
        let pending_status: Option<String> = self
            .connection
            .query_row(
                "SELECT status FROM materials WHERE id = ?1",
                [&staged.id],
                |row| row.get(0),
            )
            .optional()?;
        if pending_status.as_deref() == Some("pending") {
            // 元数据先落到 pending。若进程在文件移动后、ready 提交前中断,
            // 恢复器可以直接把已检查出的标题/作者/语言带入 ready。
            self.connection.execute(
                "UPDATE materials SET title=?1, author=?2, language=?3
                 WHERE id = ?4 AND status = 'pending'",
                params![
                    metadata.title,
                    metadata.author,
                    metadata.language,
                    staged.id
                ],
            )?;
        }
        let transaction =
            rusqlite::Transaction::new_unchecked(self.connection, TransactionBehavior::Immediate)?;

        let staged_row: Option<(String, String, String, String, Option<String>)> = transaction
            .query_row(
                "SELECT status, fingerprint, format, source_file_name, deleted_at
                 FROM materials WHERE id = ?1",
                [&staged.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((status, stored_fingerprint, stored_format, stored_file_name, deleted_at)) =
            staged_row
        else {
            return Err(AppError::StagedFileMissing(staged.id.clone()));
        };
        if stored_fingerprint != staged.fingerprint
            || stored_format != format
            || stored_file_name != staged.original_file_name
        {
            return Err(AppError::StagedFileMissing(staged.id.clone()));
        }
        let stash_path = paths.stash_path(&staged.id);
        if status == "ready" {
            let managed_path = paths.managed_path(&staged.id);
            if !managed_path.is_file() || fingerprint_file(&managed_path)? != staged.fingerprint {
                return Err(AppError::ManagedFileMissing(staged.id.clone()));
            }
            if deleted_at.is_some() {
                transaction.execute(
                    "UPDATE materials SET deleted_at = NULL, updated_at = datetime('now')
                     WHERE id = ?1",
                    [&staged.id],
                )?;
            }
            if let Some(source_cover) = source_cover {
                write_source_cover(&staged.id, source_cover, paths)?;
            }
            transaction.commit()?;
            let _ = std::fs::remove_file(stash_path);
            return self
                .find_by_id(&staged.id)?
                .ok_or_else(|| AppError::MaterialNotFound(staged.id.clone()));
        }
        if status != "pending"
            || !stash_path.is_file()
            || fingerprint_file(&stash_path)? != staged.fingerprint
        {
            return Err(AppError::StagedFileMissing(staged.id.clone()));
        }

        // 查重包含回收站中的 ready 材料:命中回收站时恢复原 BookId,而不是新建副本。
        let existing: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT id, deleted_at
                 FROM materials
                 WHERE status = 'ready' AND fingerprint = ?1 AND format = ?2
                 ORDER BY created_at LIMIT 1",
                params![staged.fingerprint, format],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((existing_id, deleted_at)) = existing {
            let existing_path = paths.managed_path(&existing_id);
            if !existing_path.is_file() || fingerprint_file(&existing_path)? != staged.fingerprint {
                // 完整指纹相同意味着用户明确选择了同一本材料;用原子替换恢复
                // 既有 BookId,不创建重复实体,并保留元数据/批注/进度。
                atomic_copy_replace(&stash_path, &existing_path)?;
            }
            let trashed_path = paths.trashed_path(&existing_id);
            if trashed_path.is_file() {
                let _ = std::fs::remove_file(trashed_path);
            }
            transaction.execute("DELETE FROM materials WHERE id = ?1", [&staged.id])?;
            if deleted_at.is_some() {
                transaction.execute(
                    "UPDATE materials SET deleted_at = NULL, updated_at = datetime('now')
                     WHERE id = ?1",
                    [&existing_id],
                )?;
            }
            if let Some(source_cover) = source_cover {
                write_source_cover(&existing_id, source_cover, paths)?;
            }
            transaction.commit()?;
            // 暂存文件已不再需要。清理失败不把已成功的去重导入报告为失败;
            // 下次启动恢复会删除无数据库记录的暂存孤儿。
            let _ = std::fs::remove_file(stash_path);
            return self
                .find_by_id(&existing_id)?
                .ok_or(AppError::MaterialNotFound(existing_id));
        }

        let managed_path = paths.managed_path(&staged.id);
        if let Err(error) = std::fs::rename(stash_path, &managed_path) {
            return Err(classify_io_error(error));
        }

        if let Err(error) = transaction.execute(
            "UPDATE materials SET status='ready', updated_at=datetime('now')
             WHERE id = ?1 AND status = 'pending'",
            [&staged.id],
        ) {
            let _ = transaction.rollback();
            let _ = std::fs::remove_file(&managed_path);
            return Err(error.into());
        }

        if let Some(source_cover) = source_cover {
            if let Err(error) = write_source_cover(&staged.id, source_cover, paths) {
                let _ = transaction.rollback();
                let _ = std::fs::remove_file(&managed_path);
                return Err(error);
            }
        }

        if let Err(error) = transaction.commit() {
            // 不删除托管副本:若 SQLite 已经提交,ready 记录仍有有效文件;
            // 若事务回滚,pending + 匹配文件可由启动恢复继续完成。
            return Err(error.into());
        }

        self.find_by_id(&staged.id)?
            .ok_or_else(|| AppError::MaterialNotFound(staged.id.clone()))
    }

    /// 列出活跃书库中的阅读材料(带覆盖优先、来源兜底的有效元数据)。
    pub fn list_materials(&self) -> Result<Vec<ReadingMaterial>, AppError> {
        Ok(self
            .load_materials("m.status = ?1 AND m.deleted_at IS NULL", &[&"ready"])?
            .into_iter()
            .map(|(material, _)| material)
            .collect())
    }

    /// 列出回收站中的阅读材料(普通删除移除正文副本,仅从活跃书库隐藏)。
    pub fn list_trashed(&self) -> Result<Vec<ReadingMaterial>, AppError> {
        Ok(self
            .load_materials("m.status = ?1 AND m.deleted_at IS NOT NULL", &[&"ready"])?
            .into_iter()
            .map(|(material, _)| material)
            .collect())
    }

    /// 普通删除:把阅读材料移入回收站并移除正文副本。
    /// 保留 BookId、封面、覆盖以及批注/位置/设置,以便恢复或重新关联。
    pub fn trash(&self, id: &str, paths: &LibraryPaths) -> Result<ReadingMaterial, AppError> {
        self.ensure_active(id)?;
        self.connection.execute(
            "UPDATE materials SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?1",
            [id],
        )?;
        let managed_path = paths.managed_path(id);
        if managed_path.is_file() {
            let trashed_path = paths.trashed_path(id);
            if trashed_path.is_file() {
                std::fs::remove_file(&trashed_path).map_err(classify_io_error)?;
            }
            std::fs::rename(&managed_path, &trashed_path).map_err(classify_io_error)?;
        }
        let mut material = self
            .find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))?;
        material.managed_file_available = false;
        Ok(material)
    }

    /// 从回收站恢复阅读材料,继续使用原 BookId 与全部阅读数据。
    pub fn restore(&self, id: &str, paths: &LibraryPaths) -> Result<ReadingMaterial, AppError> {
        self.ensure_trashed(id)?;
        let managed_path = paths.managed_path(id);
        let trashed_path = paths.trashed_path(id);
        if !managed_path.is_file() && trashed_path.is_file() {
            atomic_copy_replace(&trashed_path, &managed_path)?;
            std::fs::remove_file(&trashed_path).map_err(classify_io_error)?;
        } else if managed_path.is_file() && trashed_path.is_file() {
            std::fs::remove_file(&trashed_path).map_err(classify_io_error)?;
        }
        self.connection.execute(
            "UPDATE materials SET deleted_at = NULL, updated_at = datetime('now')
             WHERE id = ?1",
            [id],
        )?;
        let mut material = self
            .find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))?;
        material.managed_file_available = paths.managed_path(id).is_file();
        Ok(material)
    }

    /// 用完整内容指纹相同的暂存文件恢复既有材料的托管副本。
    /// 不改变 BookId、来源/覆盖元数据、阅读位置或批注,也不自动改变回收站状态。
    pub fn relink(
        &self,
        material_id: &str,
        staged: &StagedImport,
        paths: &LibraryPaths,
    ) -> Result<ReadingMaterial, AppError> {
        let material: (String, String, String) = self
            .connection
            .query_row(
                "SELECT status, fingerprint, format FROM materials WHERE id = ?1",
                [material_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::MaterialNotFound(material_id.to_string()))?;
        if material.0 != "ready"
            || material.1 != staged.fingerprint
            || material.2 != format_from_file_name(&staged.original_file_name)
        {
            return Err(AppError::ManagedFileMissing(material_id.to_string()));
        }

        let staged_row: Option<(String, String, String)> = self
            .connection
            .query_row(
                "SELECT status, fingerprint, format FROM materials WHERE id = ?1",
                [&staged.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((status, fingerprint, format)) = staged_row else {
            return Err(AppError::StagedFileMissing(staged.id.clone()));
        };
        if status != "pending"
            || fingerprint != staged.fingerprint
            || format != format_from_file_name(&staged.original_file_name)
        {
            return Err(AppError::StagedFileMissing(staged.id.clone()));
        }

        let stash_path = paths.stash_path(&staged.id);
        if !stash_path.is_file() || fingerprint_file(&stash_path)? != staged.fingerprint {
            return Err(AppError::StagedFileMissing(staged.id.clone()));
        }
        atomic_copy_replace(&stash_path, &paths.managed_path(material_id))?;
        let trashed_path = paths.trashed_path(material_id);
        if trashed_path.is_file() {
            std::fs::remove_file(trashed_path).map_err(classify_io_error)?;
        }
        let transaction =
            rusqlite::Transaction::new_unchecked(self.connection, TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM materials WHERE id = ?1 AND status = 'pending'",
            [&staged.id],
        )?;
        transaction.commit()?;
        let _ = std::fs::remove_file(stash_path);
        self.find_by_id(material_id)?
            .ok_or_else(|| AppError::MaterialNotFound(material_id.to_string()))
    }

    /// 永久删除回收站中的材料:先切断迁移恢复快照,再删记录并清理其它文件。
    /// 若中途异常终止,启动恢复器会按「无数据库记录的孤儿文件」清理,不会留下错误的 ready 状态。
    pub fn purge(&self, id: &str, paths: &LibraryPaths) -> Result<(), AppError> {
        self.ensure_trashed(id)?;
        let fingerprint: String = self.connection.query_row(
            "SELECT fingerprint FROM materials WHERE id = ?1",
            [id],
            |row| row.get(0),
        )?;
        // 先删除可恢复快照,避免进程在删库后崩溃时仍可通过快照恢复出材料。
        remove_material_migration_snapshots(id, paths)?;
        self.connection
            .execute("DELETE FROM materials WHERE id = ?1", [id])?;
        let managed_path = paths.managed_path(id);
        if managed_path.is_file() {
            std::fs::remove_file(&managed_path).map_err(classify_io_error)?;
        }
        let trashed_path = paths.trashed_path(id);
        if trashed_path.is_file() {
            std::fs::remove_file(&trashed_path).map_err(classify_io_error)?;
        }
        let cover_path = paths.cover_path(id);
        if cover_path.is_file() {
            std::fs::remove_file(&cover_path).map_err(classify_io_error)?;
        }
        let source_cover_path = paths.source_cover_path(id);
        if source_cover_path.is_file() {
            std::fs::remove_file(&source_cover_path).map_err(classify_io_error)?;
        }
        let recovery_path = paths.recovery_path(id)?;
        if recovery_path.is_file() {
            std::fs::remove_file(&recovery_path).map_err(classify_io_error)?;
        }
        remove_material_derived_caches(&fingerprint, paths)?;
        Ok(())
    }

    /// 覆盖/清除标题与作者。title/author 为 None 表示清除对应覆盖并回落到来源。
    /// 返回更新后的有效材料。
    pub fn apply_metadata(
        &self,
        id: &str,
        title: Option<&str>,
        author: Option<&str>,
    ) -> Result<ReadingMaterial, AppError> {
        self.ensure_ready(id)?;
        self.connection.execute(
            "INSERT INTO material_overrides (material_id, title, author)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(material_id) DO UPDATE SET
                title = excluded.title, author = excluded.author, updated_at = datetime('now')",
            params![id, title, author],
        )?;
        self.find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))
    }

    /// 把外部图片复制进托管封面空间并设为自定义封面。外部原文件不被修改或删除。
    /// 返回更新后的有效材料。
    pub fn set_cover(
        &self,
        id: &str,
        source_path: &Path,
        paths: &LibraryPaths,
    ) -> Result<ReadingMaterial, AppError> {
        self.ensure_ready(id)?;
        let cover_path = paths.cover_path(id);
        std::fs::copy(source_path, &cover_path).map_err(classify_io_error)?;
        let cover_source = id.to_string();
        self.connection.execute(
            "INSERT INTO material_overrides (material_id, cover_source)
             VALUES (?1, ?2)
             ON CONFLICT(material_id) DO UPDATE SET
                cover_source = excluded.cover_source, updated_at = datetime('now')",
            params![id, cover_source],
        )?;
        self.find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))
    }

    /// 移除自定义封面:删除托管封面文件并清除封面覆盖,其他覆盖(标题/作者)保留。
    /// 返回更新后的有效材料。
    pub fn remove_cover(
        &self,
        id: &str,
        paths: &LibraryPaths,
    ) -> Result<ReadingMaterial, AppError> {
        self.ensure_ready(id)?;
        self.connection.execute(
            "INSERT INTO material_overrides (material_id, cover_source)
             VALUES (?1, NULL)
             ON CONFLICT(material_id) DO UPDATE SET
                cover_source = NULL, updated_at = datetime('now')",
            [id],
        )?;
        let cover_path = paths.cover_path(id);
        if cover_path.is_file() {
            std::fs::remove_file(&cover_path).map_err(classify_io_error)?;
        }
        self.find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))
    }

    /// 一键清除标题、作者与封面的全部覆盖并恢复来源元数据。返回更新后的有效材料。
    pub fn restore_source(
        &self,
        id: &str,
        paths: &LibraryPaths,
    ) -> Result<ReadingMaterial, AppError> {
        self.ensure_ready(id)?;
        self.connection.execute(
            "DELETE FROM material_overrides WHERE material_id = ?1",
            [id],
        )?;
        let cover_path = paths.cover_path(id);
        if cover_path.is_file() {
            std::fs::remove_file(&cover_path).map_err(classify_io_error)?;
        }
        self.find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))
    }

    /// 读取有效托管封面文件的原始字节;自定义优先、来源兜底。
    pub fn read_cover(&self, id: &str, paths: &LibraryPaths) -> Result<Option<Vec<u8>>, AppError> {
        self.ensure_ready(id)?;
        let cover_path = if paths.cover_path(id).is_file() {
            paths.cover_path(id)
        } else {
            paths.source_cover_path(id)
        };
        if !cover_path.is_file() {
            return Ok(None);
        }
        Ok(Some(read_file_bytes(&cover_path)?))
    }

    pub fn read_cover_payload(
        &self,
        id: &str,
        paths: &LibraryPaths,
    ) -> Result<Option<CoverPayload>, AppError> {
        Ok(self.read_cover(id, paths)?.map(|bytes| CoverPayload {
            mime_type: image_mime_type(&bytes),
            bytes: base64::engine::general_purpose::STANDARD.encode(bytes),
        }))
    }

    /// 启动恢复:处理 pending 记录,并清理确认无主的暂存与托管文件。
    ///
    /// 对每条 pending 记录:
    /// - 若对应托管文件已存在且指纹匹配 → 说明崩溃发生在「移动文件之后、置 ready 之前」,安全完成(置 ready)。
    /// - 若文件缺失或指纹不匹配 → 回滚(删除 pending 记录与文件)。
    ///
    /// 之后再清理没有任何数据库记录引用的孤儿暂存/托管文件。
    /// 绝不删除 ready 阅读材料或外部原文件。
    pub fn recover(&self, paths: &LibraryPaths) -> Result<(), AppError> {
        let pending_rows = self.list_pending_rows()?;
        for (id, fingerprint, format) in pending_rows {
            let managed_path = paths.managed_path(&id);
            let managed_is_valid = if managed_path.is_file() {
                fingerprint_file(&managed_path)? == fingerprint
            } else {
                false
            };

            if managed_is_valid {
                let transaction = rusqlite::Transaction::new_unchecked(
                    self.connection,
                    TransactionBehavior::Immediate,
                )?;
                let duplicate: Option<(String, Option<String>)> = transaction
                    .query_row(
                        "SELECT id, deleted_at FROM materials
                         WHERE status = 'ready' AND fingerprint = ?1 AND format = ?2 AND id <> ?3
                         LIMIT 1",
                        params![fingerprint, format, id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if let Some((duplicate_id, deleted_at)) = duplicate {
                    let duplicate_path = paths.managed_path(&duplicate_id);
                    let duplicate_is_valid = duplicate_path.is_file()
                        && fingerprint_file(&duplicate_path)? == fingerprint;
                    if !duplicate_is_valid {
                        // 不在启动阶段覆盖或删除 ready 副本;保留 pending 与有效
                        // 暂存副本,等待显式修复流程处理冲突。
                        continue;
                    }
                    transaction.execute("DELETE FROM materials WHERE id = ?1", [&id])?;
                    if deleted_at.is_some() {
                        transaction.execute(
                            "UPDATE materials SET deleted_at = NULL, updated_at = datetime('now')
                             WHERE id = ?1",
                            [&duplicate_id],
                        )?;
                    }
                    transaction.commit()?;
                    let _ = std::fs::remove_file(&managed_path);
                    let _ = std::fs::remove_file(paths.stash_path(&id));
                } else {
                    transaction.execute(
                        "UPDATE materials SET status='ready', updated_at=datetime('now')
                         WHERE id = ?1 AND status = 'pending'",
                        [&id],
                    )?;
                    transaction.commit()?;
                    let _ = std::fs::remove_file(paths.stash_path(&id));
                }
            } else {
                let transaction = rusqlite::Transaction::new_unchecked(
                    self.connection,
                    TransactionBehavior::Immediate,
                )?;
                transaction.execute("DELETE FROM materials WHERE id = ?1", [&id])?;
                transaction.commit()?;
                let _ = std::fs::remove_file(&managed_path);
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
            if !entry.path().is_file() {
                continue;
            }
            match self.lifecycle(&file_name)? {
                Some((_, true)) => {
                    let trashed_path = paths.trashed_path(&file_name);
                    if trashed_path.exists() {
                        let _ = std::fs::remove_file(entry.path());
                    } else {
                        let _ = std::fs::rename(entry.path(), trashed_path);
                    }
                }
                Some((_, false)) => {}
                None => {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        for entry in std::fs::read_dir(&paths.trashed_dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if !entry.path().is_file() {
                continue;
            }
            match self.lifecycle(&file_name)? {
                Some((_, true)) => {}
                Some((_, false)) => {
                    let managed_path = paths.managed_path(&file_name);
                    if managed_path.exists() {
                        let _ = std::fs::remove_file(entry.path());
                    } else {
                        let _ = std::fs::rename(entry.path(), managed_path);
                    }
                }
                None => {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        for entry in std::fs::read_dir(&paths.covers_dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_file() && self.find_by_id(&file_name)?.is_none() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        for entry in std::fs::read_dir(&paths.source_covers_dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_file() && self.find_by_id(&file_name)?.is_none() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    fn list_pending_rows(&self) -> Result<Vec<(String, String, String)>, AppError> {
        let mut statement = self
            .connection
            .prepare("SELECT id, fingerprint, format FROM materials WHERE status = 'pending'")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        Ok(ids)
    }

    fn find_by_id(&self, id: &str) -> Result<Option<ReadingMaterial>, AppError> {
        Ok(self
            .load_materials("m.id = ?1", &[&id])?
            .into_iter()
            .map(|(material, _)| material)
            .next())
    }

    /// 用 LEFT JOIN material_overrides 读取材料,并计算覆盖优先、来源兜底的有效元数据。
    /// 返回 (有效材料, 是否在回收站)。
    fn load_materials(
        &self,
        where_clause: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<(ReadingMaterial, bool)>, AppError> {
        let sql = "SELECT
                        m.id, m.fingerprint, m.source_file_name,
                        m.title, m.author, m.language,
                        o.title, o.author, o.cover_source,
                        m.deleted_at, m.document_version
                    FROM materials m
                    LEFT JOIN material_overrides o ON o.material_id = m.id";
        let full_sql = format!("{sql} WHERE {where_clause} ORDER BY m.created_at");
        let mut statement = self.connection.prepare(&full_sql)?;
        let rows = statement.query_map(params, material_from_row)?;
        let mut materials = Vec::new();
        for row in rows {
            materials.push(row?);
        }
        Ok(materials)
    }

    /// 校验材料存在且为 ready 状态,用于元数据覆盖命令。
    fn ensure_ready(&self, id: &str) -> Result<(), AppError> {
        let status: Option<String> = self
            .connection
            .query_row("SELECT status FROM materials WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .ok();
        match status.as_deref() {
            Some("ready") => Ok(()),
            _ => Err(AppError::MaterialNotFound(id.to_string())),
        }
    }

    /// 校验材料存在、为 ready 且不在回收站(活跃),用于移入回收站。
    fn ensure_active(&self, id: &str) -> Result<(), AppError> {
        match self.lifecycle(id)? {
            Some((status, trashed)) if status == "ready" && !trashed => Ok(()),
            _ => Err(AppError::MaterialNotFound(id.to_string())),
        }
    }

    /// 校验材料存在且在回收站,用于恢复与永久删除。
    fn ensure_trashed(&self, id: &str) -> Result<(), AppError> {
        match self.lifecycle(id)? {
            Some((status, trashed)) if status == "ready" && trashed => Ok(()),
            _ => Err(AppError::MaterialNotFound(id.to_string())),
        }
    }

    /// 读取材料生命周期:(status, 是否在回收站)。
    fn lifecycle(&self, id: &str) -> Result<Option<(String, bool)>, AppError> {
        let row: Option<(String, Option<String>)> = self
            .connection
            .query_row(
                "SELECT status, deleted_at FROM materials WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        Ok(row.map(|(status, deleted_at)| (status, deleted_at.is_some())))
    }
}

fn material_from_row(row: &rusqlite::Row) -> rusqlite::Result<(ReadingMaterial, bool)> {
    let id: String = row.get(0)?;
    let fingerprint: String = row.get(1)?;
    let source_file_name: String = row.get(2)?;
    let source_title: String = row.get(3)?;
    let source_author: Option<String> = row.get(4)?;
    let source_language: Option<String> = row.get(5)?;
    let override_title: Option<String> = row.get(6)?;
    let override_author: Option<String> = row.get(7)?;
    let override_cover: Option<String> = row.get(8)?;
    let deleted_at: Option<String> = row.get(9)?;
    let document_version: i64 = row.get(10)?;

    let source = SourceMetadata {
        title: source_title.clone(),
        author: source_author.clone(),
        language: source_language.clone(),
    };
    let user_override = MaterialOverride {
        title: override_title,
        author: override_author,
        cover_source: override_cover,
    };
    Ok((
        ReadingMaterial {
            id,
            fingerprint,
            source_file_name,
            source,
            title: user_override
                .title
                .clone()
                .unwrap_or_else(|| source_title.clone()),
            author: user_override
                .author
                .clone()
                .or_else(|| source_author.clone()),
            language: source_language,
            cover_source: user_override.cover_source.clone(),
            source_cover_source: None,
            user_override,
            document_version,
            managed_file_available: true,
        },
        deleted_at.is_some(),
    ))
}

fn write_source_cover(
    material_id: &str,
    cover: &SourceCover,
    paths: &LibraryPaths,
) -> Result<(), AppError> {
    const MAX_SOURCE_COVER_BYTES: usize = 64 * 1024 * 1024;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&cover.bytes)
        .map_err(|_| AppError::BackupValidation("来源封面不是有效 Base64".to_string()))?;
    if bytes.is_empty() || bytes.len() > MAX_SOURCE_COVER_BYTES {
        return Err(AppError::BackupValidation("来源封面超过资源预算".to_string()));
    }
    if !matches!(
        cover.mime_type.as_str(),
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    ) {
        return Err(AppError::BackupValidation(format!(
            "来源封面 MIME 不受支持:{}",
            cover.mime_type
        )));
    }
    if image_mime_type(&bytes) != cover.mime_type {
        return Err(AppError::BackupValidation(
            "来源封面 MIME 与字节签名不一致".to_string(),
        ));
    }
    crate::fs::atomic_write(&paths.source_cover_path(material_id), &bytes)
}

fn restore_version_migration_source_cover(snapshot_path: &Path, target: &Path) -> Result<(), AppError> {
    let snapshot_cover = snapshot_path.join("source-cover");
    if snapshot_cover.is_file() {
        atomic_copy(&snapshot_cover, target)
    } else if target.is_file() {
        std::fs::remove_file(target).map_err(classify_io_error)
    } else {
        Ok(())
    }
}

fn image_mime_type(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg".to_string()
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        "image/png".to_string()
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp".to_string()
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

fn format_from_file_name(file_name: &str) -> &'static str {
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".epub") {
        "epub"
    } else if lower.ends_with(".pdf") {
        "pdf"
    } else if lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mkd")
        || lower.ends_with(".mdown")
    {
        "markdown"
    } else {
        "unknown"
    }
}

/// 永久清理材料对应的 EPUB 推导目录缓存。缓存文件名是私有哈希,因此按
/// 缓存 envelope 中的完整内容指纹匹配,不把材料 ID 拼接进文件系统路径。
fn remove_material_derived_caches(fingerprint: &str, paths: &LibraryPaths) -> Result<(), AppError> {
    for entry in std::fs::read_dir(&paths.derived_toc_cache_dir).map_err(classify_io_error)? {
        let entry = entry.map_err(classify_io_error)?;
        if !entry.path().is_file() {
            continue;
        }
        let matches = std::fs::read_to_string(entry.path())
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| {
                value
                    .get("sourceFingerprint")
                    .and_then(|item| item.as_str())
                    .map(|value| value == fingerprint)
            })
            .unwrap_or(false);
        if matches {
            std::fs::remove_file(entry.path()).map_err(classify_io_error)?;
        }
    }
    Ok(())
}

/// 永久清理材料对应的迁移恢复快照,包括崩溃后留下的临时快照目录。
fn remove_material_migration_snapshots(
    material_id: &str,
    paths: &LibraryPaths,
) -> Result<(), AppError> {
    for entry in std::fs::read_dir(&paths.version_migration_dir).map_err(classify_io_error)? {
        let entry = entry.map_err(classify_io_error)?;
        let root = entry.path();
        if !root.is_dir() {
            continue;
        }
        let manifest = version_migration_manifest_path(&root);
        let raw = match std::fs::read_to_string(&manifest) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let matches = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| {
                value
                    .get("materialId")
                    .and_then(|item| item.as_str())
                    .map(|value| value == material_id)
            })
            .unwrap_or_else(|| raw.contains(&format!("\"materialId\":\"{material_id}\"")));
        if matches {
            std::fs::remove_dir_all(root).map_err(classify_io_error)?;
        }
    }
    Ok(())
}

fn version_migration_manifest_path(root: &Path) -> PathBuf {
    root.join("manifest.json")
}

fn read_version_migration_manifest(
    root: &Path,
) -> Result<VersionMigrationManifest, AppError> {
    let bytes = std::fs::read(version_migration_manifest_path(root)).map_err(classify_io_error)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| AppError::BackupValidation(format!("迁移快照 manifest 无法解析:{error}")))
}

pub fn read_version_migration_material_id(root: &Path) -> Result<String, AppError> {
    let manifest = read_version_migration_manifest(root)?;
    if manifest.phase != "completed" {
        return Err(AppError::BackupValidation(
            "迁移恢复快照尚未完成,不能作为用户恢复源".to_string(),
        ));
    }
    Ok(manifest.material_id)
}

/// 在打开 SQLite 前回滚崩溃时尚未标记 completed 的迁移操作。
/// 已完成快照持续保留,不在启动阶段自动清理。
pub fn recover_version_migrations(paths: &LibraryPaths) -> Result<(), AppError> {
    for entry in std::fs::read_dir(&paths.version_migration_dir).map_err(classify_io_error)? {
        let entry = entry.map_err(classify_io_error)?;
        let root = entry.path();
        if root.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.starts_with('.') {
            let _ = std::fs::remove_dir_all(root);
            continue;
        }
        let manifest = match read_version_migration_manifest(&root) {
            Ok(manifest) => manifest,
            Err(_) => continue,
        };
        if manifest.phase == "completed" {
            continue;
        }
        let database = root.join("database.sqlite");
        let material = root.join("material.epub");
        if database.is_file() && material.is_file() {
            atomic_copy(&database, &paths.database_path())?;
            atomic_copy(&material, &paths.managed_path(&manifest.material_id))?;
            restore_version_migration_source_cover(
                &root,
                &paths.source_cover_path(&manifest.material_id),
            )?;
        }
        let _ = std::fs::remove_dir_all(root);
    }
    Ok(())
}

fn write_version_migration_manifest(
    root: &Path,
    manifest: &VersionMigrationManifest,
) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(manifest).map_err(AppError::BackupManifestSerialize)?;
    atomic_write(&version_migration_manifest_path(root), &bytes)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn migrated_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("migrations/0001_workspace.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0002_materials.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0003_import_pending.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0004_material_overrides.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0005_material_trash.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0006_annotations.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!(
                "migrations/0007_material_document_version.sql"
            ))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0008_import_identity.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!(
                "migrations/0009_annotation_recovery_state.sql"
            ))
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
    fn discard_after_successful_commit_keeps_ready_material() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"bytes");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        repository.discard(&staged, &paths).unwrap();

        assert_eq!(repository.list_materials().unwrap().len(), 1);
        assert!(paths.managed_path(&material.id).is_file());
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
            .query_row(
                "SELECT COUNT(*) FROM materials WHERE id = ?1",
                params![material.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn explicit_version_migration_commits_data_atomically_and_recovery_rolls_back_prepared_snapshot() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let old_source = write_source(&paths, "old.epub", b"old-epub");
        let old_staged = repository.stage(&old_source, &paths).unwrap();
        let old_source_cover = SourceCover {
            bytes: "/9j/2Q==".to_string(),
            mime_type: "image/jpeg".to_string(),
        };
        let old_material = repository
            .commit_with_source_cover(
                &old_staged,
                &MaterialMetadata {
                    title: "同一本书".to_string(),
                    author: Some("作者".to_string()),
                    language: Some("zh".to_string()),
                },
                &paths,
                Some(&old_source_cover),
            )
            .unwrap();
        let annotation = Annotation {
            id: "annotation-1".to_string(),
            material_id: old_material.id.clone(),
            anchor: crate::db::annotations::TextAnchor {
                cfi: "epubcfi(/6/2[chapter]!/4/2)".to_string(),
                quote: "旧引文".to_string(),
                before: "前".to_string(),
                after: "后".to_string(),
                document_version: old_material.fingerprint.clone(),
                recovery_state: crate::db::annotations::AnnotationRecoveryState::Resolved,
            },
            style: "highlight".to_string(),
            color: "#ffd54f".to_string(),
            note: "旧笔记".to_string(),
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
        };
        crate::db::annotations::AnnotationRepository::new(&connection)
            .save(&annotation)
            .unwrap();
        let old_workspace = crate::db::workspace::WorkspaceState::default();
        crate::db::workspace::WorkspaceRepository::new(&connection)
            .save_state(&old_workspace)
            .unwrap();

        let new_source = write_source(&paths, "new.epub", b"new-epub");
        let new_staged = repository.stage(&new_source, &paths).unwrap();
        let new_source_cover = SourceCover {
            bytes: "/9j/3Q==".to_string(),
            mime_type: "image/jpeg".to_string(),
        };
        let migrated = repository
            .commit_version_migration(
                &VersionMigrationCommitRequest {
                    material_id: old_material.id.clone(),
                    staged: new_staged.clone(),
                    metadata: MaterialMetadata {
                        title: "同一本书".to_string(),
                        author: Some("作者".to_string()),
                        language: Some("zh".to_string()),
                    },
                    source_cover: Some(new_source_cover),
                    expected_source_fingerprint: old_material.fingerprint.clone(),
                    expected_target_fingerprint: new_staged.fingerprint.clone(),
                    annotations: vec![annotation.clone()],
                    workspace_state: serde_json::to_value(&old_workspace).unwrap(),
                },
                &paths,
            )
            .unwrap();

        assert_eq!(migrated.material.id, old_material.id);
        assert_eq!(migrated.material.fingerprint, new_staged.fingerprint);
        assert_eq!(migrated.material.document_version, 0);
        assert_eq!(
            std::fs::read(paths.managed_path(&old_material.id)).unwrap(),
            b"new-epub"
        );
        assert_eq!(
            std::fs::read(paths.source_cover_path(&old_material.id)).unwrap(),
            vec![0xff, 0xd8, 0xff, 0xdd]
        );
        assert!(matches!(
            repository.list_version_migration_snapshots(&paths).unwrap()[0].status.as_str(),
            "available"
        ));

        let snapshot_path = paths.version_migration_path(&migrated.snapshot_id).unwrap();
        let mut manifest = read_version_migration_manifest(&snapshot_path).unwrap();
        manifest.phase = "prepared".to_string();
        write_version_migration_manifest(&snapshot_path, &manifest).unwrap();
        recover_version_migrations(&paths).unwrap();

        let recovered_connection = Connection::open(paths.database_path()).unwrap();
        let recovered_repository = ImportRepository::new(&recovered_connection);
        let recovered = recovered_repository
            .find_by_id(&old_material.id)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.fingerprint, old_material.fingerprint);
        assert_eq!(
            std::fs::read(paths.managed_path(&old_material.id)).unwrap(),
            b"old-epub"
        );
        assert_eq!(
            std::fs::read(paths.source_cover_path(&old_material.id)).unwrap(),
            vec![0xff, 0xd8, 0xff, 0xd9]
        );
        assert_eq!(
            crate::db::annotations::AnnotationRepository::new(&recovered_connection)
                .list_by_material(&old_material.id)
                .unwrap(),
            vec![annotation]
        );
        assert!(!snapshot_path.exists());
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
    fn commit_retry_after_success_returns_same_material() {
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
        let retry = repository.commit(&staged, &metadata, &paths).unwrap();

        assert_eq!(retry.id, first.id);
        assert_eq!(repository.list_materials().unwrap().len(), 1);
    }

    #[test]
    fn same_bytes_with_different_formats_create_distinct_materials() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let epub_source = write_source(&paths, "book.epub", b"same-bytes");
        let epub = repository.stage(&epub_source, &paths).unwrap();
        let epub_material = repository
            .commit(
                &epub,
                &MaterialMetadata {
                    title: "EPUB".to_string(),
                    ..Default::default()
                },
                &paths,
            )
            .unwrap();

        let markdown_source = write_source(&paths, "book.md", b"same-bytes");
        let markdown = repository.stage(&markdown_source, &paths).unwrap();
        let markdown_material = repository
            .commit(
                &markdown,
                &MaterialMetadata {
                    title: "Markdown".to_string(),
                    ..Default::default()
                },
                &paths,
            )
            .unwrap();

        assert_ne!(markdown_material.id, epub_material.id);
        assert_eq!(repository.list_materials().unwrap().len(), 2);
    }

    #[test]
    fn concurrent_same_identity_commits_leave_one_ready_material_and_copy() {
        let dir = std::env::temp_dir().join(format!(
            "ai-reader-concurrent-import-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = LibraryPaths::new(&dir).unwrap();
        let db_path = paths.database_path();
        drop(crate::db::open_database(&db_path).unwrap());

        let source_a = dir.join("a.epub");
        let source_b = dir.join("b.epub");
        std::fs::write(&source_a, b"concurrent-content").unwrap();
        std::fs::write(&source_b, b"concurrent-content").unwrap();

        let connection_a = crate::db::open_database(&db_path).unwrap();
        let connection_b = crate::db::open_database(&db_path).unwrap();
        let staged_a = ImportRepository::new(&connection_a)
            .stage(&source_a, &paths)
            .unwrap();
        let staged_b = ImportRepository::new(&connection_b)
            .stage(&source_b, &paths)
            .unwrap();
        let staged_a_id = staged_a.id.clone();
        let staged_b_id = staged_b.id.clone();
        drop(connection_a);
        drop(connection_b);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let paths_a = paths.clone();
        let paths_b = paths.clone();

        let db_path_a = db_path.clone();
        let db_path_b = db_path.clone();
        let (result_a, result_b) = std::thread::scope(|scope| {
            let barrier_a = barrier.clone();
            let barrier_b = barrier.clone();
            let handle_a = scope.spawn(move || {
                barrier_a.wait();
                let connection = crate::db::open_database(&db_path_a).unwrap();
                ImportRepository::new(&connection).commit(
                    &staged_a,
                    &MaterialMetadata {
                        title: "甲".to_string(),
                        ..Default::default()
                    },
                    &paths_a,
                )
            });
            let handle_b = scope.spawn(move || {
                barrier_b.wait();
                let connection = crate::db::open_database(&db_path_b).unwrap();
                ImportRepository::new(&connection).commit(
                    &staged_b,
                    &MaterialMetadata {
                        title: "乙".to_string(),
                        ..Default::default()
                    },
                    &paths_b,
                )
            });
            (handle_a.join().unwrap(), handle_b.join().unwrap())
        });

        let material_a = result_a.unwrap();
        let material_b = result_b.unwrap();
        assert_eq!(material_a.id, material_b.id);
        let verify = crate::db::open_database(&db_path).unwrap();
        let repository = ImportRepository::new(&verify);
        let materials = repository.list_materials().unwrap();
        assert_eq!(materials.len(), 1);
        assert_eq!(
            std::fs::read(paths.managed_path(&material_a.id)).unwrap(),
            b"concurrent-content"
        );
        assert!(!paths.stash_path(&staged_a_id).exists());
        assert!(!paths.stash_path(&staged_b_id).exists());
        drop(verify);
        std::fs::remove_dir_all(dir).unwrap();
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

        assert!(matches!(error, AppError::StagedFileMissing(_)));
    }

    #[test]
    fn commit_rejects_changed_staged_bytes_and_recovery_cleans_them() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"original");
        let staged = repository.stage(&source, &paths).unwrap();
        std::fs::write(paths.stash_path(&staged.id), b"changed").unwrap();

        let error = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap_err();

        assert!(matches!(error, AppError::StagedFileMissing(_)));
        assert!(repository.list_materials().unwrap().is_empty());
        repository.recover(&paths).unwrap();
        assert!(!paths.stash_path(&staged.id).exists());
        assert!(repository.list_materials().unwrap().is_empty());
    }

    #[test]
    fn list_materials_returns_committed_materials_in_order() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        for (name, bytes, title) in [("a.epub", b"aaa", "甲"), ("b.epub", b"bbb", "乙")] {
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
    fn managed_file_info_returns_name_and_size_without_a_path() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"managed-epub-bytes");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        let info = repository.managed_file_info(&material.id, &paths).unwrap();

        assert_eq!(info.name, "book.epub");
        assert_eq!(info.size, b"managed-epub-bytes".len() as u64);
    }

    #[test]
    fn read_managed_range_uses_half_open_offsets_and_rejects_invalid_requests() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"0123456789");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        assert_eq!(
            repository
                .read_managed_range(&material.id, 2, 4, &paths)
                .unwrap(),
            b"2345"
        );
        assert_eq!(
            repository
                .read_managed_range(&material.id, 10, 0, &paths)
                .unwrap(),
            b""
        );
        assert!(matches!(
            repository.read_managed_range(&material.id, 0, 8 * 1024 * 1024 + 1, &paths),
            Err(AppError::ManagedRangeTooLarge(_))
        ));
        assert!(matches!(
            repository.read_managed_range(&material.id, 8, 3, &paths),
            Err(AppError::ManagedRangeOutOfBounds { .. })
        ));
    }

    #[test]
    fn read_managed_range_rejects_unknown_trashed_and_missing_material_files() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"content");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        assert!(matches!(
            repository.read_managed_range("missing", 0, 1, &paths),
            Err(AppError::MaterialNotFound(_))
        ));
        assert!(matches!(
            repository.managed_file_path("../outside", &paths),
            Err(AppError::InvalidMaterialId(_))
        ));
        repository.trash(&material.id, &paths).unwrap();
        assert!(matches!(
            repository.read_managed_range(&material.id, 0, 1, &paths),
            Err(AppError::MaterialNotFound(_))
        ));

        let restored = repository.restore(&material.id, &paths).unwrap();
        std::fs::remove_file(paths.managed_path(&restored.id)).unwrap();
        assert!(matches!(
            repository.read_managed_range(&restored.id, 0, 1, &paths),
            Err(AppError::ManagedFileMissing(_))
        ));
    }

    #[test]
    fn save_markdown_atomically_replaces_file_increments_version_and_updates_fingerprint() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.md", "# title\n\nbody".as_bytes());
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(
                &staged,
                &MaterialMetadata {
                    title: "标题".to_string(),
                    ..Default::default()
                },
                &paths,
            )
            .unwrap();
        assert_eq!(material.document_version, 0);

        let updated = repository
            .save_markdown(&material.id, "# 标题\n\n新的正文", &paths)
            .unwrap();

        assert_eq!(updated.id, material.id);
        assert_eq!(updated.document_version, 1);
        assert_ne!(updated.fingerprint, material.fingerprint);
        assert_eq!(
            std::fs::read(paths.managed_path(&material.id)).unwrap(),
            "# 标题\n\n新的正文".as_bytes()
        );
        // 写入后指纹与内容一致。
        assert_eq!(
            updated.fingerprint,
            fingerprint_bytes("# 标题\n\n新的正文".as_bytes())
        );
    }

    #[test]
    fn save_markdown_rejects_duplicate_content_without_replacing_file() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let first_source = write_source(&paths, "first.md", b"first");
        let first_staged = repository.stage(&first_source, &paths).unwrap();
        let first = repository
            .commit(&first_staged, &MaterialMetadata::default(), &paths)
            .unwrap();
        let second_source = write_source(&paths, "second.md", b"second");
        let second_staged = repository.stage(&second_source, &paths).unwrap();
        repository
            .commit(&second_staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        let error = repository
            .save_markdown(&first.id, "second", &paths)
            .unwrap_err();

        assert!(matches!(error, AppError::DuplicateMaterial(_)));
        assert_eq!(std::fs::read(paths.managed_path(&first.id)).unwrap(), b"first");
        assert_eq!(repository.find_by_id(&first.id).unwrap().unwrap().document_version, 0);
    }

    #[test]
    fn save_markdown_increments_version_on_each_save() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.md", b"v0");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        let v1 = repository
            .save_markdown(&material.id, "v1", &paths)
            .unwrap();
        let v2 = repository
            .save_markdown(&material.id, "v2", &paths)
            .unwrap();

        assert_eq!(v1.document_version, 1);
        assert_eq!(v2.document_version, 2);
        assert!(!paths.stash_path(&staged.id).exists());
    }

    #[test]
    fn save_markdown_rejects_unknown_material() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();

        let error = repository
            .save_markdown("no-such", "content", &paths)
            .unwrap_err();

        assert!(matches!(error, AppError::MaterialNotFound(_)));
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
    fn recover_keeps_ready_record_when_managed_file_is_missing() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"content");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();
        std::fs::remove_file(paths.managed_path(&material.id)).unwrap();

        repository.recover(&paths).unwrap();

        assert_eq!(repository.list_materials().unwrap().len(), 1);
        assert!(matches!(
            repository.read_managed_range(&material.id, 0, 1, &paths),
            Err(AppError::ManagedFileMissing(_))
        ));
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
        std::fs::rename(paths.stash_path(&staged.id), paths.managed_path(&staged.id)).unwrap();
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
    fn recover_removes_pending_record_when_managed_copy_fingerprint_is_wrong() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"original");
        let staged = repository.stage(&source, &paths).unwrap();
        std::fs::rename(paths.stash_path(&staged.id), paths.managed_path(&staged.id)).unwrap();
        std::fs::write(paths.managed_path(&staged.id), b"corrupted").unwrap();

        repository.recover(&paths).unwrap();

        assert!(repository.list_materials().unwrap().is_empty());
        assert!(!paths.managed_path(&staged.id).exists());
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

    fn ready_material(
        connection: &Connection,
        paths: &LibraryPaths,
        title: &str,
        author: Option<&str>,
    ) -> ReadingMaterial {
        let repository = ImportRepository::new(connection);
        let source = write_source(paths, "book.epub", b"metadata-content");
        let staged = repository.stage(&source, paths).unwrap();
        let metadata = MaterialMetadata {
            title: title.to_string(),
            author: author.map(str::to_string),
            language: Some("zh".to_string()),
        };
        repository.commit(&staged, &metadata, paths).unwrap()
    }

    #[test]
    fn apply_metadata_overrides_title_and_author_and_keeps_source_snapshot() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", Some("来源作者"));

        let updated = repository
            .apply_metadata(&material.id, Some("整理标题"), Some("整理作者"))
            .unwrap();

        assert_eq!(updated.title, "整理标题");
        assert_eq!(updated.author.as_deref(), Some("整理作者"));
        assert_eq!(updated.source.title, "来源标题");
        assert_eq!(updated.source.author.as_deref(), Some("来源作者"));
        assert_eq!(updated.user_override.title.as_deref(), Some("整理标题"));

        let listed = repository.list_materials().unwrap();
        assert_eq!(listed[0].title, "整理标题");
        assert_eq!(listed[0].source.title, "来源标题");
    }

    #[test]
    fn apply_metadata_clear_falls_back_to_source() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", Some("来源作者"));
        repository
            .apply_metadata(&material.id, Some("整理标题"), Some("整理作者"))
            .unwrap();

        let restored = repository.apply_metadata(&material.id, None, None).unwrap();

        assert_eq!(restored.title, "来源标题");
        assert_eq!(restored.author.as_deref(), Some("来源作者"));
        assert!(restored.user_override.title.is_none());
        assert!(restored.user_override.author.is_none());
    }

    #[test]
    fn set_cover_copies_to_managed_space_without_touching_source() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", None);
        let external_cover = paths.stash_dir.join("cover.png");
        std::fs::write(&external_cover, b"png-bytes").unwrap();

        let updated = repository
            .set_cover(&material.id, &external_cover, &paths)
            .unwrap();

        assert_eq!(updated.cover_source.as_deref(), Some(material.id.as_str()));
        assert!(paths.cover_path(&material.id).is_file());
        assert_eq!(
            std::fs::read(paths.cover_path(&material.id)).unwrap(),
            b"png-bytes"
        );
        // 外部原文件不被修改或删除。
        assert_eq!(std::fs::read(&external_cover).unwrap(), b"png-bytes");
        // 内容身份稳定。
        assert_eq!(updated.fingerprint, material.fingerprint);
        assert_eq!(updated.source.title, "来源标题");
    }

    #[test]
    fn source_cover_is_persisted_separately_and_custom_cover_falls_back_to_it() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"metadata-content");
        let staged = repository.stage(&source, &paths).unwrap();
        let metadata = MaterialMetadata {
            title: "来源标题".to_string(),
            author: None,
            language: Some("zh".to_string()),
        };
        let source_cover = SourceCover {
            bytes: "/9j/2Q==".to_string(),
            mime_type: "image/jpeg".to_string(),
        };
        let material = repository
            .commit_with_source_cover(&staged, &metadata, &paths, Some(&source_cover))
            .unwrap();

        assert_eq!(
            repository.read_cover(&material.id, &paths).unwrap().unwrap(),
            vec![0xff, 0xd8, 0xff, 0xd9]
        );
        assert!(paths.source_cover_path(&material.id).is_file());
        assert!(!paths.cover_path(&material.id).is_file());

        let custom = paths.stash_dir.join("custom.jpg");
        std::fs::write(&custom, b"custom-cover").unwrap();
        repository.set_cover(&material.id, &custom, &paths).unwrap();
        assert_eq!(
            repository.read_cover(&material.id, &paths).unwrap().unwrap(),
            b"custom-cover"
        );
        repository.remove_cover(&material.id, &paths).unwrap();
        assert_eq!(
            repository.read_cover(&material.id, &paths).unwrap().unwrap(),
            vec![0xff, 0xd8, 0xff, 0xd9]
        );
    }

    #[test]
    fn remove_cover_deletes_managed_cover_and_keeps_other_overrides() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", None);
        let external_cover = paths.stash_dir.join("cover.png");
        std::fs::write(&external_cover, b"png-bytes").unwrap();
        repository
            .set_cover(&material.id, &external_cover, &paths)
            .unwrap();
        repository
            .apply_metadata(&material.id, Some("整理标题"), None)
            .unwrap();

        let removed = repository.remove_cover(&material.id, &paths).unwrap();

        assert!(removed.cover_source.is_none());
        assert!(!paths.cover_path(&material.id).exists());
        // 其它覆盖(标题)保留。
        assert_eq!(removed.title, "整理标题");
    }

    #[test]
    fn restore_source_clears_all_overrides_and_cover() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", Some("来源作者"));
        repository
            .apply_metadata(&material.id, Some("整理标题"), Some("整理作者"))
            .unwrap();
        let external_cover = paths.stash_dir.join("cover.png");
        std::fs::write(&external_cover, b"png-bytes").unwrap();
        repository
            .set_cover(&material.id, &external_cover, &paths)
            .unwrap();

        let restored = repository.restore_source(&material.id, &paths).unwrap();

        assert_eq!(restored.title, "来源标题");
        assert_eq!(restored.author.as_deref(), Some("来源作者"));
        assert!(restored.cover_source.is_none());
        assert!(restored.user_override.title.is_none());
        assert!(!paths.cover_path(&material.id).exists());
    }

    #[test]
    fn read_cover_returns_bytes_when_present_and_null_when_absent() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", None);

        assert!(repository
            .read_cover(&material.id, &paths)
            .unwrap()
            .is_none());

        let external_cover = paths.stash_dir.join("cover.png");
        std::fs::write(&external_cover, b"png-bytes").unwrap();
        repository
            .set_cover(&material.id, &external_cover, &paths)
            .unwrap();

        assert_eq!(
            repository
                .read_cover(&material.id, &paths)
                .unwrap()
                .unwrap(),
            b"png-bytes"
        );
    }

    #[test]
    fn metadata_override_persists_across_restart() {
        // 用真实文件数据库验证覆盖值在应用重启后保持。
        let dir = std::env::temp_dir().join(format!("ai-reader-meta-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("ai-reader.db");
        let paths = LibraryPaths::new(&dir).unwrap();

        let material_id = {
            let mut connection = Connection::open(&db_path).unwrap();
            crate::db::run_migrations(&mut connection, crate::db::MIGRATIONS).unwrap();
            let repository = ImportRepository::new(&connection);
            let source = write_source(&paths, "book.epub", b"persist-content");
            let staged = repository.stage(&source, &paths).unwrap();
            let material = repository
                .commit(
                    &staged,
                    &MaterialMetadata {
                        title: "来源标题".to_string(),
                        ..Default::default()
                    },
                    &paths,
                )
                .unwrap();
            repository
                .apply_metadata(&material.id, Some("整理标题"), Some("整理作者"))
                .unwrap();
            material.id
        };

        // 模拟重启:重新打开数据库与路径。
        let mut connection = Connection::open(&db_path).unwrap();
        crate::db::run_migrations(&mut connection, crate::db::MIGRATIONS).unwrap();
        let repository = ImportRepository::new(&connection);

        let loaded = repository.find_by_id(&material_id).unwrap().unwrap();
        assert_eq!(loaded.title, "整理标题");
        assert_eq!(loaded.author.as_deref(), Some("整理作者"));
        assert_eq!(loaded.source.title, "来源标题");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn metadata_commands_reject_unknown_material() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();

        let error = repository
            .apply_metadata("no-such", Some("标题"), None)
            .unwrap_err();

        assert!(matches!(error, AppError::MaterialNotFound(_)));
        let _ = paths;
    }

    #[test]
    fn trash_hides_from_active_and_lists_in_trash_keeping_data() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", Some("来源作者"));
        repository
            .apply_metadata(&material.id, Some("整理标题"), None)
            .unwrap();
        let external_cover = paths.stash_dir.join("trash-cover.png");
        std::fs::write(&external_cover, b"png-bytes").unwrap();
        repository
            .set_cover(&material.id, &external_cover, &paths)
            .unwrap();

        let trashed = repository.trash(&material.id, &paths).unwrap();

        assert!(repository.list_materials().unwrap().is_empty());
        let trashed_list = repository.list_trashed().unwrap();
        assert_eq!(trashed_list.len(), 1);
        assert_eq!(trashed_list[0].id, material.id);
        assert_eq!(trashed_list[0].title, "整理标题");
        assert_eq!(
            trashed_list[0].cover_source.as_deref(),
            Some(material.id.as_str())
        );
        assert_eq!(trashed.id, material.id);
        // 正文副本移除,封面与数据库用户数据保留。
        assert!(!paths.managed_path(&material.id).exists());
        assert!(paths.trashed_path(&material.id).is_file());
        assert!(paths.cover_path(&material.id).is_file());
    }

    #[test]
    fn trash_rejects_unknown_or_already_trashed() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "甲", None);
        repository.trash(&material.id, &paths).unwrap();

        assert!(matches!(
            repository.trash(&material.id, &paths).unwrap_err(),
            AppError::MaterialNotFound(_)
        ));
        assert!(matches!(
            repository.trash("no-such", &paths).unwrap_err(),
            AppError::MaterialNotFound(_)
        ));
    }

    #[test]
    fn restore_returns_same_book_id_with_all_data() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", Some("来源作者"));
        repository
            .apply_metadata(&material.id, Some("整理标题"), Some("整理作者"))
            .unwrap();
        repository.trash(&material.id, &paths).unwrap();

        let restored = repository.restore(&material.id, &paths).unwrap();

        assert_eq!(restored.id, material.id);
        assert_eq!(restored.title, "整理标题");
        assert_eq!(restored.author.as_deref(), Some("整理作者"));
        assert_eq!(restored.source.title, "来源标题");
        assert_eq!(repository.list_materials().unwrap().len(), 1);
        assert!(repository.list_trashed().unwrap().is_empty());
        assert!(restored.managed_file_available);
        assert!(paths.managed_path(&material.id).is_file());
        assert!(!paths.trashed_path(&material.id).exists());
    }

    #[test]
    fn restore_rejects_active_material() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "甲", None);

        let error = repository.restore(&material.id, &paths).unwrap_err();

        assert!(matches!(error, AppError::MaterialNotFound(_)));
    }

    #[test]
    fn relink_restores_missing_managed_file_without_creating_a_new_material() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "甲", None);
        std::fs::remove_file(paths.managed_path(&material.id)).unwrap();

        let replacement = write_source(&paths, "replacement.epub", b"metadata-content");
        let staged = repository.stage(&replacement, &paths).unwrap();
        let relinked = repository.relink(&material.id, &staged, &paths).unwrap();

        assert_eq!(relinked.id, material.id);
        assert!(relinked.managed_file_available);
        assert_eq!(
            std::fs::read(paths.managed_path(&material.id)).unwrap(),
            b"metadata-content"
        );
        assert_eq!(repository.list_materials().unwrap().len(), 1);
        assert!(!paths.stash_path(&staged.id).exists());
    }

    #[test]
    fn reimport_same_fingerprint_repairs_missing_active_material_without_duplicate() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "甲", None);
        std::fs::remove_file(paths.managed_path(&material.id)).unwrap();

        let replacement = write_source(&paths, "replacement.epub", b"metadata-content");
        let staged = repository.stage(&replacement, &paths).unwrap();
        let imported = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        assert_eq!(imported.id, material.id);
        assert_eq!(repository.list_materials().unwrap().len(), 1);
        assert_eq!(
            repository
                .read_managed_range(&material.id, 0, b"metadata-content".len() as u64, &paths)
                .unwrap(),
            b"metadata-content"
        );
    }

    #[test]
    fn purge_removes_record_managed_file_and_cover() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", None);
        let external_cover = paths.stash_dir.join("purge-cover.png");
        std::fs::write(&external_cover, b"png-bytes").unwrap();
        repository
            .set_cover(&material.id, &external_cover, &paths)
            .unwrap();
        repository.trash(&material.id, &paths).unwrap();
        assert!(!paths.managed_path(&material.id).exists());
        std::fs::write(paths.recovery_path(&material.id).unwrap(), b"snapshot").unwrap();

        repository.purge(&material.id, &paths).unwrap();

        assert!(repository.list_materials().unwrap().is_empty());
        assert!(repository.list_trashed().unwrap().is_empty());
        assert!(!paths.managed_path(&material.id).exists());
        assert!(!paths.cover_path(&material.id).exists());
        assert!(!paths.recovery_path(&material.id).unwrap().exists());
        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM materials WHERE id=?1",
                params![material.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn purge_removes_derived_cache_and_version_migration_snapshots() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "甲", None);
        let cache_path = paths.derived_toc_cache_path("book-cache").unwrap();
        std::fs::write(
            &cache_path,
            format!(r#"{{"sourceFingerprint":"{}"}}"#, material.fingerprint),
        )
        .unwrap();
        let snapshot_path = paths.version_migration_path("snapshot-1").unwrap();
        std::fs::create_dir_all(&snapshot_path).unwrap();
        write_version_migration_manifest(
            &snapshot_path,
            &VersionMigrationManifest {
                id: "snapshot-1".to_string(),
                material_id: material.id.clone(),
                source_fingerprint: material.fingerprint.clone(),
                target_fingerprint: "target".to_string(),
                created_at: now_millis(),
                phase: "completed".to_string(),
            },
        )
        .unwrap();
        repository.trash(&material.id, &paths).unwrap();

        repository.purge(&material.id, &paths).unwrap();

        assert!(!cache_path.exists());
        assert!(!snapshot_path.exists());
    }

    #[test]
    fn purge_rejects_active_material() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "甲", None);

        let error = repository.purge(&material.id, &paths).unwrap_err();

        assert!(matches!(error, AppError::MaterialNotFound(_)));
        assert!(paths.managed_path(&material.id).is_file());
    }

    #[test]
    fn reimport_same_fingerprint_restores_trashed_material_with_original_book_id() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.epub", b"same-content");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(
                &staged,
                &MaterialMetadata {
                    title: "甲".to_string(),
                    ..Default::default()
                },
                &paths,
            )
            .unwrap();
        repository.trash(&material.id, &paths).unwrap();

        // 重新导入相同完整内容指纹。
        let source2 = write_source(&paths, "copy.epub", b"same-content");
        let staged2 = repository.stage(&source2, &paths).unwrap();
        let recomitted = repository
            .commit(
                &staged2,
                &MaterialMetadata {
                    title: "乙".to_string(),
                    ..Default::default()
                },
                &paths,
            )
            .unwrap();

        assert_eq!(recomitted.id, material.id);
        assert!(repository.list_trashed().unwrap().is_empty());
        let active = repository.list_materials().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, material.id);
        assert!(!paths.stash_path(&staged2.id).exists());
    }

    #[test]
    fn different_content_with_same_metadata_creates_new_material_after_trash() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "a.epub", b"content-a");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(
                &staged,
                &MaterialMetadata {
                    title: "甲".to_string(),
                    ..Default::default()
                },
                &paths,
            )
            .unwrap();
        repository.trash(&material.id, &paths).unwrap();

        let source2 = write_source(&paths, "b.epub", b"content-b");
        let staged2 = repository.stage(&source2, &paths).unwrap();
        let second = repository
            .commit(
                &staged2,
                &MaterialMetadata {
                    title: "甲".to_string(),
                    ..Default::default()
                },
                &paths,
            )
            .unwrap();

        assert_ne!(second.id, material.id);
        assert_eq!(repository.list_trashed().unwrap().len(), 1);
        assert_eq!(repository.list_materials().unwrap().len(), 1);
    }
}
