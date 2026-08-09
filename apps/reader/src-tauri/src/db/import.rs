use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{classify_io_error, AppError};
use crate::fs::{atomic_write, fingerprint_bytes, read_file_bytes, stream_copy_with_fingerprint, LibraryPaths};

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
    /// 材料文档版本:正式保存 Markdown 时递增(EPUB/PDF 内容不可变,保持 0)。
    pub document_version: i64,
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

    /// 正式保存 Markdown 内容(ADR-0009):用托管文件原子替换、递增文档版本并更新
    /// 完整内容指纹,BookId 保持不变。TS 端不直接写文件,只调用本命令。
    ///
    /// 顺序:先原子写入托管文件,再更新指纹与版本。若原子写入失败,数据库记录与
    /// 旧文件保持一致,不会出现半本内容。返回更新后的有效材料。
    pub fn save_markdown(
        &self,
        id: &str,
        content: &str,
        paths: &LibraryPaths,
    ) -> Result<ReadingMaterial, AppError> {
        self.ensure_ready(id)?;
        let managed_path = paths.managed_path(id);
        atomic_write(&managed_path, content.as_bytes())?;
        let fingerprint = fingerprint_bytes(content.as_bytes());
        self.connection.execute(
            "UPDATE materials
             SET fingerprint = ?1, document_version = document_version + 1, updated_at = datetime('now')
             WHERE id = ?2",
            params![fingerprint, id],
        )?;
        self.find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))
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
        // 查重看 ready 材料(含回收站):活跃材料直接返回;回收站中相同指纹则恢复原 BookId,不新建。
        if let Some((existing, trashed)) = self.find_by_fingerprint(&staged.fingerprint)? {
            self.connection
                .execute("DELETE FROM materials WHERE id = ?1", [&staged.id])?;
            let _ = std::fs::remove_file(paths.stash_path(&staged.id));
            if trashed {
                self.connection.execute(
                    "UPDATE materials SET deleted_at = NULL, updated_at = datetime('now')
                     WHERE id = ?1",
                    [&existing.id],
                )?;
            }
            return self
                .find_by_id(&existing.id)?
                .ok_or_else(|| AppError::MaterialNotFound(existing.id));
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
            fingerprint: staged.fingerprint.clone(),
            source_file_name: staged.original_file_name.clone(),
            source: SourceMetadata {
                title: metadata.title.clone(),
                author: metadata.author.clone(),
                language: metadata.language.clone(),
            },
            user_override: MaterialOverride::default(),
            title: metadata.title.clone(),
            author: metadata.author.clone(),
            language: metadata.language.clone(),
            cover_source: None,
            document_version: 0,
        })
    }

    /// 列出活跃书库中的阅读材料(带覆盖优先、来源兜底的有效元数据)。
    pub fn list_materials(&self) -> Result<Vec<ReadingMaterial>, AppError> {
        Ok(self
            .load_materials("m.status = ?1 AND m.deleted_at IS NULL", &[&"ready"])?
            .into_iter()
            .map(|(material, _)| material)
            .collect())
    }

    /// 列出回收站中的阅读材料(普通删除保留全部数据,仅从活跃书库隐藏)。
    pub fn list_trashed(&self) -> Result<Vec<ReadingMaterial>, AppError> {
        Ok(self
            .load_materials("m.status = ?1 AND m.deleted_at IS NOT NULL", &[&"ready"])?
            .into_iter()
            .map(|(material, _)| material)
            .collect())
    }

    /// 普通删除:把阅读材料移入回收站并从活跃书库隐藏。
    /// 保留 BookId、托管文件、封面、覆盖以及批注/位置/设置,以便恢复。
    pub fn trash(&self, id: &str) -> Result<ReadingMaterial, AppError> {
        self.ensure_active(id)?;
        self.connection.execute(
            "UPDATE materials SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?1",
            [id],
        )?;
        self.find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))
    }

    /// 从回收站恢复阅读材料,继续使用原 BookId 与全部阅读数据。
    pub fn restore(&self, id: &str) -> Result<ReadingMaterial, AppError> {
        self.ensure_trashed(id)?;
        self.connection.execute(
            "UPDATE materials SET deleted_at = NULL, updated_at = datetime('now')
             WHERE id = ?1",
            [id],
        )?;
        self.find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))
    }

    /// 永久删除回收站中的材料:先删记录(级联清理覆盖),再移除托管文件与封面。
    /// 若中途异常终止,启动恢复器会按「无数据库记录的孤儿文件」清理,不会留下错误的 ready 状态。
    pub fn purge(&self, id: &str, paths: &LibraryPaths) -> Result<(), AppError> {
        self.ensure_trashed(id)?;
        self.connection
            .execute("DELETE FROM materials WHERE id = ?1", [id])?;
        let managed_path = paths.managed_path(id);
        if managed_path.is_file() {
            std::fs::remove_file(&managed_path).map_err(classify_io_error)?;
        }
        let cover_path = paths.cover_path(id);
        if cover_path.is_file() {
            std::fs::remove_file(&cover_path).map_err(classify_io_error)?;
        }
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
        self.connection
            .execute("DELETE FROM material_overrides WHERE material_id = ?1", [id])?;
        let cover_path = paths.cover_path(id);
        if cover_path.is_file() {
            std::fs::remove_file(&cover_path).map_err(classify_io_error)?;
        }
        self.find_by_id(id)?
            .ok_or_else(|| AppError::MaterialNotFound(id.to_string()))
    }

    /// 读取托管封面文件的原始字节;无自定义封面时返回 None。
    pub fn read_cover(
        &self,
        id: &str,
        paths: &LibraryPaths,
    ) -> Result<Option<Vec<u8>>, AppError> {
        self.ensure_ready(id)?;
        let cover_path = paths.cover_path(id);
        if !cover_path.is_file() {
            return Ok(None);
        }
        Ok(Some(read_file_bytes(&cover_path)?))
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
        for entry in std::fs::read_dir(&paths.covers_dir)? {
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

    fn find_by_fingerprint(
        &self,
        fingerprint: &str,
    ) -> Result<Option<(ReadingMaterial, bool)>, AppError> {
        Ok(self
            .load_materials("m.fingerprint = ?1 AND m.status = 'ready'", &[&fingerprint])?
            .into_iter()
            .next())
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

fn material_from_row(
    row: &rusqlite::Row,
) -> rusqlite::Result<(ReadingMaterial, bool)> {
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
            author: user_override.author.clone().or_else(|| source_author.clone()),
            language: source_language,
            cover_source: user_override.cover_source.clone(),
            user_override,
            document_version,
        },
        deleted_at.is_some(),
    ))
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
            .execute_batch(include_str!("migrations/0004_material_overrides.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0005_material_trash.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0006_annotations.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0007_material_document_version.sql"))
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
    fn save_markdown_atomically_replaces_file_increments_version_and_updates_fingerprint() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.md", "# title\n\nbody".as_bytes());
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata { title: "标题".to_string(), ..Default::default() }, &paths)
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
    fn save_markdown_increments_version_on_each_save() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "book.md", b"v0");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata::default(), &paths)
            .unwrap();

        let v1 = repository.save_markdown(&material.id, "v1", &paths).unwrap();
        let v2 = repository.save_markdown(&material.id, "v2", &paths).unwrap();

        assert_eq!(v1.document_version, 1);
        assert_eq!(v2.document_version, 2);
        assert!(!paths.stash_path(&staged.id).exists());
    }

    #[test]
    fn save_markdown_rejects_unknown_material() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();

        let error = repository.save_markdown("no-such", "content", &paths).unwrap_err();

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

        let restored = repository
            .apply_metadata(&material.id, None, None)
            .unwrap();

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

        let updated = repository.set_cover(&material.id, &external_cover, &paths).unwrap();

        assert_eq!(updated.cover_source.as_deref(), Some(material.id.as_str()));
        assert!(paths.cover_path(&material.id).is_file());
        assert_eq!(std::fs::read(paths.cover_path(&material.id)).unwrap(), b"png-bytes");
        // 外部原文件不被修改或删除。
        assert_eq!(std::fs::read(&external_cover).unwrap(), b"png-bytes");
        // 内容身份稳定。
        assert_eq!(updated.fingerprint, material.fingerprint);
        assert_eq!(updated.source.title, "来源标题");
    }

    #[test]
    fn remove_cover_deletes_managed_cover_and_keeps_other_overrides() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", None);
        let external_cover = paths.stash_dir.join("cover.png");
        std::fs::write(&external_cover, b"png-bytes").unwrap();
        repository.set_cover(&material.id, &external_cover, &paths).unwrap();
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
        repository.set_cover(&material.id, &external_cover, &paths).unwrap();

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

        assert!(repository.read_cover(&material.id, &paths).unwrap().is_none());

        let external_cover = paths.stash_dir.join("cover.png");
        std::fs::write(&external_cover, b"png-bytes").unwrap();
        repository.set_cover(&material.id, &external_cover, &paths).unwrap();

        assert_eq!(
            repository.read_cover(&material.id, &paths).unwrap().unwrap(),
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
                .commit(&staged, &MaterialMetadata { title: "来源标题".to_string(), ..Default::default() }, &paths)
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
        repository.set_cover(&material.id, &external_cover, &paths).unwrap();

        let trashed = repository.trash(&material.id).unwrap();

        assert!(repository.list_materials().unwrap().is_empty());
        let trashed_list = repository.list_trashed().unwrap();
        assert_eq!(trashed_list.len(), 1);
        assert_eq!(trashed_list[0].id, material.id);
        assert_eq!(trashed_list[0].title, "整理标题");
        assert_eq!(trashed_list[0].cover_source.as_deref(), Some(material.id.as_str()));
        assert_eq!(trashed.id, material.id);
        // 托管文件与封面保留。
        assert!(paths.managed_path(&material.id).is_file());
        assert!(paths.cover_path(&material.id).is_file());
    }

    #[test]
    fn trash_rejects_unknown_or_already_trashed() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "甲", None);
        repository.trash(&material.id).unwrap();

        assert!(matches!(
            repository.trash(&material.id).unwrap_err(),
            AppError::MaterialNotFound(_)
        ));
        assert!(matches!(
            repository.trash("no-such").unwrap_err(),
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
        repository.trash(&material.id).unwrap();

        let restored = repository.restore(&material.id).unwrap();

        assert_eq!(restored.id, material.id);
        assert_eq!(restored.title, "整理标题");
        assert_eq!(restored.author.as_deref(), Some("整理作者"));
        assert_eq!(restored.source.title, "来源标题");
        assert_eq!(repository.list_materials().unwrap().len(), 1);
        assert!(repository.list_trashed().unwrap().is_empty());
        assert!(paths.managed_path(&material.id).is_file());
    }

    #[test]
    fn restore_rejects_active_material() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "甲", None);

        let error = repository.restore(&material.id).unwrap_err();

        assert!(matches!(error, AppError::MaterialNotFound(_)));
    }

    #[test]
    fn purge_removes_record_managed_file_and_cover() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let material = ready_material(&connection, &paths, "来源标题", None);
        let external_cover = paths.stash_dir.join("purge-cover.png");
        std::fs::write(&external_cover, b"png-bytes").unwrap();
        repository.set_cover(&material.id, &external_cover, &paths).unwrap();
        repository.trash(&material.id).unwrap();
        assert!(paths.managed_path(&material.id).is_file());

        repository.purge(&material.id, &paths).unwrap();

        assert!(repository.list_materials().unwrap().is_empty());
        assert!(repository.list_trashed().unwrap().is_empty());
        assert!(!paths.managed_path(&material.id).exists());
        assert!(!paths.cover_path(&material.id).exists());
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM materials WHERE id=?1", params![material.id], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
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
            .commit(&staged, &MaterialMetadata { title: "甲".to_string(), ..Default::default() }, &paths)
            .unwrap();
        repository.trash(&material.id).unwrap();

        // 重新导入相同完整内容指纹。
        let source2 = write_source(&paths, "copy.epub", b"same-content");
        let staged2 = repository.stage(&source2, &paths).unwrap();
        let recomitted = repository
            .commit(&staged2, &MaterialMetadata { title: "乙".to_string(), ..Default::default() }, &paths)
            .unwrap();

        assert_eq!(recomitted.id, material.id);
        assert!(repository.list_trashed().unwrap().is_empty());
        let active = repository.list_materials().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, material.id);
        assert!(!paths.stash_path(&staged2.id).exists());
    }

    #[test]
    fn reimport_different_fingerprint_creates_new_material_after_trash() {
        let connection = migrated_connection();
        let repository = ImportRepository::new(&connection);
        let paths = temp_paths();
        let source = write_source(&paths, "a.epub", b"content-a");
        let staged = repository.stage(&source, &paths).unwrap();
        let material = repository
            .commit(&staged, &MaterialMetadata { title: "甲".to_string(), ..Default::default() }, &paths)
            .unwrap();
        repository.trash(&material.id).unwrap();

        let source2 = write_source(&paths, "b.epub", b"content-b");
        let staged2 = repository.stage(&source2, &paths).unwrap();
        let second = repository
            .commit(&staged2, &MaterialMetadata { title: "乙".to_string(), ..Default::default() }, &paths)
            .unwrap();

        assert_ne!(second.id, material.id);
        assert_eq!(repository.list_trashed().unwrap().len(), 1);
        assert_eq!(repository.list_materials().unwrap().len(), 1);
    }
}
