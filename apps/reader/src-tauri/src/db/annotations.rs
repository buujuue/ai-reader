use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 文本锚点的恢复状态(ADR-0008)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationRecoveryState {
    Resolved,
    Orphaned,
}

/// 文本锚点:把批注重新定位到材料内容的版本化数据。Rust 只原样存取,不参与恢复语义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAnchor {
    pub cfi: String,
    pub quote: String,
    pub before: String,
    pub after: String,
    pub document_version: String,
    pub recovery_state: AnnotationRecoveryState,
}

/// 批注 DTO:归属 material_id(BookId),字段与 TS 端保持一致(camelCase)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub material_id: String,
    pub anchor: TextAnchor,
    pub style: String,
    pub color: String,
    pub note: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

/// 批注的持久化仓储。批注是材料级实体,按 material_id 归属,不涉及阅读视图标识。
pub struct AnnotationRepository<'a> {
    connection: &'a Connection,
}

impl<'a> AnnotationRepository<'a> {
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    /// 读取一份阅读材料的全部未删除批注(材料级集合)。
    pub fn list_by_material(&self, material_id: &str) -> Result<Vec<Annotation>, AppError> {
        let mut statement = self.connection.prepare(
            "SELECT id, material_id, cfi, quote, before, after, document_version,
                    recovery_state, style, color, note, created_at, updated_at, deleted_at
             FROM annotations
             WHERE material_id = ?1 AND deleted_at IS NULL
             ORDER BY created_at",
        )?;
        let rows = statement.query_map([material_id], annotation_from_row)?;
        let mut annotations = Vec::new();
        for row in rows {
            annotations.push(row?);
        }
        Ok(annotations)
    }

    /// 创建或更新一条批注(含编辑文字笔记)。按 id 幂等 upsert。
    /// 校验材料存在,避免孤儿批注附着到不存在的材料。
    pub fn save(&self, annotation: &Annotation) -> Result<Annotation, AppError> {
        self.ensure_material(&annotation.material_id)?;
        self.connection.execute(
            "INSERT INTO annotations
                (id, material_id, cfi, quote, before, after, document_version,
                 recovery_state, style, color, note, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
                material_id = excluded.material_id,
                cfi = excluded.cfi,
                quote = excluded.quote,
                before = excluded.before,
                after = excluded.after,
                document_version = excluded.document_version,
                recovery_state = excluded.recovery_state,
                style = excluded.style,
                color = excluded.color,
                note = excluded.note,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at",
            params![
                annotation.id,
                annotation.material_id,
                annotation.anchor.cfi,
                annotation.anchor.quote,
                annotation.anchor.before,
                annotation.anchor.after,
                annotation.anchor.document_version,
                recovery_state_str(&annotation.anchor.recovery_state),
                annotation.style,
                annotation.color,
                annotation.note,
                annotation.created_at,
                annotation.updated_at,
                annotation.deleted_at,
            ],
        )?;
        Ok(annotation.clone())
    }

    /// 逻辑删除一条批注(保留记录,标记 deleted_at)。
    pub fn delete(&self, annotation_id: &str) -> Result<(), AppError> {
        self.connection.execute(
            "UPDATE annotations SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![chrono_timestamp(), annotation_id],
        )?;
        Ok(())
    }

    fn ensure_material(&self, material_id: &str) -> Result<(), AppError> {
        let exists: Option<i64> = self
            .connection
            .query_row(
                "SELECT 1 FROM materials WHERE id = ?1",
                [material_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(AppError::MaterialNotFound(material_id.to_string()));
        }
        Ok(())
    }
}

fn annotation_from_row(row: &rusqlite::Row) -> rusqlite::Result<Annotation> {
    let id: String = row.get(0)?;
    let material_id: String = row.get(1)?;
    let cfi: String = row.get(2)?;
    let quote: String = row.get(3)?;
    let before: String = row.get(4)?;
    let after: String = row.get(5)?;
    let document_version: String = row.get(6)?;
    let recovery_state: String = row.get(7)?;
    let style: String = row.get(8)?;
    let color: String = row.get(9)?;
    let note: String = row.get(10)?;
    let created_at: i64 = row.get(11)?;
    let updated_at: i64 = row.get(12)?;
    let deleted_at: Option<i64> = row.get(13)?;

    Ok(Annotation {
        id,
        material_id,
        anchor: TextAnchor {
            cfi,
            quote,
            before,
            after,
            document_version,
            recovery_state: match recovery_state.as_str() {
                "orphaned" => AnnotationRecoveryState::Orphaned,
                _ => AnnotationRecoveryState::Resolved,
            },
        },
        style,
        color,
        note,
        created_at,
        updated_at,
        deleted_at,
    })
}

fn recovery_state_str(state: &AnnotationRecoveryState) -> &'static str {
    match state {
        AnnotationRecoveryState::Resolved => "resolved",
        AnnotationRecoveryState::Orphaned => "orphaned",
    }
}

/// epoch 毫秒时间戳(与前端 Date.now() 一致)。
fn chrono_timestamp() -> i64 {
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
            .execute_batch(include_str!("migrations/0002_materials.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("migrations/0006_annotations.sql"))
            .unwrap();
        connection
    }

    fn seed_material(connection: &Connection, id: &str) {
        connection
            .execute(
                "INSERT INTO materials (id, status, fingerprint, title, source_file_name)
                 VALUES (?1, 'ready', ?2, ?3, ?4)",
                params![id, format!("fp-{id}"), "示例书", "book.epub"],
            )
            .unwrap();
    }

    fn sample_annotation(material_id: &str) -> Annotation {
        Annotation {
            id: "ann-1".to_string(),
            material_id: material_id.to_string(),
            anchor: TextAnchor {
                cfi: "epubcfi(/6/4)!/4/2/2/1:0".to_string(),
                quote: "被选中的文字".to_string(),
                before: "前文".to_string(),
                after: "后文".to_string(),
                document_version: "fingerprint-1".to_string(),
                recovery_state: AnnotationRecoveryState::Resolved,
            },
            style: "highlight".to_string(),
            color: "#ffd54f".to_string(),
            note: "".to_string(),
            created_at: 1000,
            updated_at: 1000,
            deleted_at: None,
        }
    }

    #[test]
    fn save_and_list_roundtrip() {
        let connection = migrated_connection();
        seed_material(&connection, "material-1");
        let repository = AnnotationRepository::new(&connection);

        repository.save(&sample_annotation("material-1")).unwrap();

        let list = repository.list_by_material("material-1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "ann-1");
        assert_eq!(list[0].anchor.quote, "被选中的文字");
        assert_eq!(list[0].anchor.recovery_state, AnnotationRecoveryState::Resolved);
    }

    #[test]
    fn annotations_are_material_scoped() {
        let connection = migrated_connection();
        seed_material(&connection, "material-1");
        seed_material(&connection, "material-2");
        let repository = AnnotationRepository::new(&connection);

        repository.save(&sample_annotation("material-1")).unwrap();
        let mut other = sample_annotation("material-2");
        other.id = "ann-2".to_string();
        repository.save(&other).unwrap();

        let list = repository.list_by_material("material-1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "ann-1");
    }

    #[test]
    fn editing_note_persists() {
        let connection = migrated_connection();
        seed_material(&connection, "material-1");
        let repository = AnnotationRepository::new(&connection);
        repository.save(&sample_annotation("material-1")).unwrap();

        let mut updated = sample_annotation("material-1");
        updated.note = "这是笔记".to_string();
        updated.updated_at = 2000;
        repository.save(&updated).unwrap();

        let list = repository.list_by_material("material-1").unwrap();
        assert_eq!(list[0].note, "这是笔记");
        assert_eq!(list[0].updated_at, 2000);
    }

    #[test]
    fn delete_logically_hides_annotation() {
        let connection = migrated_connection();
        seed_material(&connection, "material-1");
        let repository = AnnotationRepository::new(&connection);
        repository.save(&sample_annotation("material-1")).unwrap();

        repository.delete("ann-1").unwrap();

        assert!(repository.list_by_material("material-1").unwrap().is_empty());
    }

    #[test]
    fn save_rejects_unknown_material() {
        let connection = migrated_connection();
        let repository = AnnotationRepository::new(&connection);

        let error = repository.save(&sample_annotation("no-such")).unwrap_err();
        assert!(matches!(error, AppError::MaterialNotFound(_)));
    }

    #[test]
    fn orphaned_recovery_state_roundtrips() {
        let connection = migrated_connection();
        seed_material(&connection, "material-1");
        let repository = AnnotationRepository::new(&connection);

        let mut annotation = sample_annotation("material-1");
        annotation.anchor.recovery_state = AnnotationRecoveryState::Orphaned;
        repository.save(&annotation).unwrap();

        let list = repository.list_by_material("material-1").unwrap();
        assert_eq!(list[0].anchor.recovery_state, AnnotationRecoveryState::Orphaned);
    }
}