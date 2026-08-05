/** 阅读材料领域的共享类型。serde 命名(camelCase)与 Rust 端 DTO 保持一致。 */

/** 稳定 BookId(UUID)标识的一份已进入托管书库的阅读材料。 */
export interface ReadingMaterial {
  id: string;
  title: string;
  author: string | null;
  language: string | null;
  fingerprint: string;
  sourceFileName: string;
}

/** Rust 暂存后的导入句柄。 */
export interface StagedImport {
  id: string;
  originalFileName: string;
  fingerprint: string;
}

/** 从阅读材料内部解析出的不可编辑来源元数据快照。 */
export interface SourceMetadata {
  title: string;
  author: string | null;
  language: string | null;
}