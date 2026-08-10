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

/// 创建或更新一条批注(含编辑文字笔记)。校验材料存在,避免孤儿批注附着到不存在的材料。
#[tauri::command]
pub fn save_annotation(
    database: State<'_, DatabaseHandle>,
    annotation: Annotation,
) -> Result<Annotation, AppError> {
    database.with_connection(|connection| AnnotationRepository::new(connection).save(&annotation))
}

/// 逻辑删除一条批注(保留记录,标记 deleted_at)。
#[tauri::command]
pub fn delete_annotation(
    database: State<'_, DatabaseHandle>,
    annotation_id: String,
) -> Result<(), AppError> {
    database.with_connection(|connection| AnnotationRepository::new(connection).delete(&annotation_id))
}
