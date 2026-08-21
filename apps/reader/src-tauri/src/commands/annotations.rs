use std::path::Path;

use tauri::State;

use crate::db::annotations::{Annotation, AnnotationRepository};
use crate::db::DatabaseHandle;
use crate::error::AppError;

/// 读取一份阅读材料的全部未删除批注(材料级集合)。
#[tauri::command]
pub fn list_annotations(
    database: State<'_, DatabaseHandle>,
    material_id: String,
) -> Result<Vec<Annotation>, AppError> {
    database.with_connection(|connection| {
        AnnotationRepository::new(connection).list_by_material(&material_id)
    })
}

/// 读取一份阅读材料的已删除批注,用于恢复入口。
#[tauri::command]
pub fn list_deleted_annotations(
    database: State<'_, DatabaseHandle>,
    material_id: String,
) -> Result<Vec<Annotation>, AppError> {
    database.with_connection(|connection| {
        AnnotationRepository::new(connection).list_deleted_by_material(&material_id)
    })
}

/// 创建或更新一条批注(含编辑文字笔记)。校验材料存在,避免孤儿批注附着到不存在的材料。
#[tauri::command]
pub fn save_annotation(
    database: State<'_, DatabaseHandle>,
    annotation: Annotation,
) -> Result<Annotation, AppError> {
    database.with_connection(|connection| AnnotationRepository::new(connection).save(&annotation))
}

/// 在一个 SQLite 事务中创建或更新多条批注。
#[tauri::command]
pub fn save_annotations(
    database: State<'_, DatabaseHandle>,
    annotations: Vec<Annotation>,
) -> Result<Vec<Annotation>, AppError> {
    database.with_connection(|connection| {
        AnnotationRepository::new(connection).save_many(&annotations)
    })
}

/// 逻辑删除一条批注(保留记录,标记 deleted_at)。
#[tauri::command]
pub fn delete_annotation(
    database: State<'_, DatabaseHandle>,
    annotation_id: String,
) -> Result<(), AppError> {
    database.with_connection(|connection| AnnotationRepository::new(connection).delete(&annotation_id))
}

/// 恢复一条逻辑删除的批注。找不到目标时返回 null,不制造新批注。
#[tauri::command]
pub fn restore_annotation(
    database: State<'_, DatabaseHandle>,
    annotation_id: String,
) -> Result<Option<Annotation>, AppError> {
    database.with_connection(|connection| AnnotationRepository::new(connection).restore(&annotation_id))
}

/// 把前端按批注领域语义生成的 Markdown 写入用户选择的目标文件。
/// 目标路径来自系统保存位置选择器,不修改阅读材料、批注或工作区状态。
#[tauri::command]
pub fn write_annotation_markdown(
    destination_path: String,
    content: String,
) -> Result<(), AppError> {
    crate::fs::atomic_write_export_file(Path::new(&destination_path), content.as_bytes())
}
