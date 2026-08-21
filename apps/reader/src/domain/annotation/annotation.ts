/**
 * 批注(Annotation)领域类型。
 *
 * 批注是阅读材料级实体,归属于稳定 BookId,而不是某个 ReadingView。
 * 文本 Anchor 组合 CFI、选中文字、前文、后文、文档版本与恢复状态(ADR-0008),
 * 绝不只保存 DOM Range。当前选区的 DOM Range 属于 Reader Runtime,不进入
 * Workspace State 或数据库。
 */

/** 文本锚点的恢复状态。 */
export type AnnotationRecoveryState = 'resolved' | 'reanchored' | 'orphaned';

/**
 * 文本锚点(Text Anchor):把批注重新定位到材料内容的版本化数据。
 * 文档变化后先尝试原 CFI,再尝试唯一引文与上下文匹配;无法唯一恢复时
 * 保留批注并标记失联,绝不静默附着到错误文本。
 */
export interface TextAnchor {
  /** 规范化 EPUB 位置(CFI)。 */
  cfi: string;
  /** 选中文字(引文)。 */
  quote: string;
  /** 引文前文(用于唯一匹配与上下文恢复)。 */
  before: string;
  /** 引文后文。 */
  after: string;
  /** 文档版本(第一版 EPUB 内容不可变,使用材料内容指纹)。 */
  documentVersion: string;
  /** 当前恢复状态。 */
  recoveryState: AnnotationRecoveryState;
}

/** 高亮样式。第一版只支持普通高亮。 */
export type AnnotationStyle = 'highlight';

/**
 * 批注:用户创建的普通高亮或文字笔记,归属于阅读材料(materialId)。
 * 一个批注是一条高亮,可附带一条文字笔记(note)。
 */
export interface Annotation {
  /** 批注稳定标识(UUID)。 */
  id: string;
  /** 归属的阅读材料 BookId(批注是材料级实体,不归属某个阅读视图)。 */
  materialId: string;
  /** 文本锚点。 */
  anchor: TextAnchor;
  /** 高亮样式。 */
  style: AnnotationStyle;
  /** 高亮颜色。 */
  color: string;
  /** 文字笔记;空字符串表示无笔记。 */
  note: string;
  /** 创建时间(epoch 毫秒)。 */
  createdAt: number;
  /** 最后修改时间(epoch 毫秒)。 */
  updatedAt: number;
  /** 逻辑删除时间(epoch 毫秒);null 表示未删除。 */
  deletedAt: number | null;
}
