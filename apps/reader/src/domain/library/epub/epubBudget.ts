/** EPUB 导入与运行时读取共用的不可覆盖资源预算。 */
export interface EpubResourceBudget {
  /** 单个 ZIP 条目的最大解压后字节数。 */
  maxEntryUncompressedBytes: number;
  /** 全部 ZIP 条目的最大解压后字节数。 */
  maxTotalUncompressedBytes: number;
  /** 解压后字节数 / 压缩后字节数的最大允许值。 */
  maxCompressionRatio: number;
  /** 单个 spine 章节的最大解压后字节数。 */
  maxChapterUncompressedBytes: number;
  /** ZIP 中允许出现的最大条目数。 */
  maxEntryCount: number;
  /** XML/HTML 单条文档允许的最大元素嵌套深度。 */
  maxXmlNestingDepth: number;
}

/**
 * 跨 Windows、macOS、iPadOS 与 Android 平板共用的首版硬上限。
 * 普通用户不能通过导入参数覆盖这些值。
 */
export const EPUB_RESOURCE_BUDGET: Readonly<EpubResourceBudget> = Object.freeze({
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxChapterUncompressedBytes: 8 * 1024 * 1024,
  maxEntryCount: 10_000,
  maxXmlNestingDepth: 64,
});
