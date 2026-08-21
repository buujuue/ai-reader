import type { Annotation } from './annotation';

/**
 * 批注的 typed Repository 边界。TS 只调用这些命令,不接触 SQL、数据库路径
 * 或任意文件系统能力。批注归属于 BookId(materialId),读取接口返回材料级
 * 集合,不把 ReadingView 标识作为所有权。
 */
export interface AnnotationRepository {
  /** 读取一份阅读材料的全部批注(材料级集合,不含回收站已删除)。 */
  listByMaterial(materialId: string): Promise<Annotation[]>;
  /** 读取一份材料的批注 tombstone,供显式恢复入口使用。 */
  listDeletedByMaterial(materialId: string): Promise<Annotation[]>;
  /** 创建或更新一条批注(含编辑文字笔记)。 */
  saveAnnotation(annotation: Annotation): Promise<Annotation>;
  /** 在一个持久化提交中保存多条批注,用于批量重锚时避免部分更新。 */
  saveAnnotations(annotations: readonly Annotation[]): Promise<Annotation[]>;
  /** 逻辑删除一条批注。 */
  deleteAnnotation(annotationId: string): Promise<void>;
  /** 恢复一条逻辑删除的批注;目标不存在或未删除时返回 null。 */
  restoreAnnotation(annotationId: string): Promise<Annotation | null>;
}
