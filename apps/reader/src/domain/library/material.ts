/** 阅读材料领域的共享类型。serde 命名(camelCase)与 Rust 端 DTO 保持一致。 */

/** 从阅读材料内部解析出的不可编辑来源元数据快照。整理操作永不改写它。 */
export interface SourceMetadata {
  title: string;
  author: string | null;
  language: string | null;
}

/**
 * 用户覆盖值(独立数据,与来源快照分离)。字段始终存在,值为 null 表示清除该覆盖并回落到来源。
 * 第一版只允许覆盖标题、作者与封面,不把整理结果写回阅读文件。
 */
export interface MaterialOverride {
  title: string | null;
  author: string | null;
  /** 托管封面文件名(自定义封面进入应用托管空间);null 表示无自定义封面。 */
  coverSource: string | null;
}

/** 已通过安全解码/缩放的封面字节；Rust 只负责受控持久化。 */
export interface CoverAsset {
  bytes: Uint8Array;
  mimeType: string;
}

/** 空覆盖:全部回落来源。 */
export function emptyMaterialOverride(): MaterialOverride {
  return { title: null, author: null, coverSource: null };
}

/** 稳定 BookId(UUID)标识的一份已进入托管书库的阅读材料。 */
export interface ReadingMaterial {
  id: string;
  fingerprint: string;
  sourceFileName: string;
  /** 不可编辑来源元数据快照。 */
  source: SourceMetadata;
  /** 独立保存的用户覆盖值。 */
  override: MaterialOverride;
  /** 有效标题 = override.title ?? source.title(覆盖优先、来源兜底)。 */
  title: string;
  /** 有效作者 = override.author ?? source.author。 */
  author: string | null;
  /** 有效语言(第一版不可覆盖,始终等于 source.language)。 */
  language: string | null;
  /** 有效封面托管文件名(自定义封面);无自定义封面时为 null。 */
  coverSource: string | null;
  /** 来源封面托管文件名;无来源封面时为 null。与 coverSource 分层保存。 */
  sourceCoverSource?: string | null;
  /** 材料文档版本:正式保存 Markdown 时递增(EPUB/PDF 内容不可变,为 0)。 */
  documentVersion: number;
  /** 托管副本是否存在且可供阅读;缺失时仍保留材料元数据与用户数据。 */
  managedFileAvailable?: boolean;
}

/** Rust 暂存后的导入句柄。 */
export interface StagedImport {
  id: string;
  originalFileName: string;
  fingerprint: string;
}
