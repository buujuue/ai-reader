import { sanitizeEpubResource } from './sanitizer';

/**
 * 规范阅读 DOM 的版本。任何会改变清洗结果、搜索文本或 CFI 路径的变更
 * 都必须递增这个版本,让旧派生结果自然失效。
 */
export const EPUB_CANONICAL_TRANSFORM_VERSION = 'epub-canonical-v1';
/** 应用生成的展示辅助节点必须使用此标记,才能从阅读 DOM 中排除。 */
export const EPUB_DISPLAY_ONLY_ATTRIBUTE = 'data-ai-reader-display-only';

export interface EpubDerivedCache<T = string> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export interface EpubDerivedCacheKeyInput {
  sourceFingerprint: string;
  resourceType: string;
  resourceText: string;
  transformVersion?: string;
}

/** 内存派生缓存 Adapter;缓存只保存规范转换结果,不持有原书字节。 */
export function createEpubDerivedCache<T = string>(maxEntries = 256): EpubDerivedCache<T> {
  const values = new Map<string, T>();
  return {
    get: (key) => {
      const value = values.get(key);
      if (value !== undefined) {
        values.delete(key);
        values.set(key, value);
      }
      return value;
    },
    set: (key, value) => {
      values.delete(key);
      values.set(key, value);
      while (values.size > Math.max(1, maxEntries)) {
        const oldest = values.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        values.delete(oldest);
      }
    },
  };
}

/**
 * 构造规范转换派生结果的缓存键。
 * `resourceText` 使用稳定的轻量摘要,避免缓存键复制整份章节内容;完整内容
 * 指纹与转换版本仍然明确进入键,因此原书或规范转换任一变化都会重建结果。
 */
export function buildEpubDerivedCacheKey(input: EpubDerivedCacheKeyInput): string {
  const version = input.transformVersion ?? EPUB_CANONICAL_TRANSFORM_VERSION;
  return [
    'epub-derived',
    version,
    input.sourceFingerprint,
    input.resourceType,
    `${fnv1a(input.resourceText)}-${input.resourceText.length}`,
  ]
    .map(encodeURIComponent)
    .join(':');
}

export interface EpubCanonicalTransform {
  readonly version: string;
  cacheKey(resourceType: string, resourceText: string): string;
  transform(resourceType: string, resourceText: string): string;
}

export interface EpubCanonicalTransformOptions {
  sourceFingerprint: string;
  cache?: EpubDerivedCache<string>;
  transformVersion?: string;
}

/**
 * 统一的 EPUB 规范转换入口。搜索、CFI 和批注看到的内容都必须经过这里;
 * 排版主题只在转换之后由 renderer 注入,不会进入这个结果或它的缓存键。
 */
export function createEpubCanonicalTransform(
  options: EpubCanonicalTransformOptions,
): EpubCanonicalTransform {
  const version = options.transformVersion ?? EPUB_CANONICAL_TRANSFORM_VERSION;
  const cache = options.cache ?? createEpubDerivedCache<string>();
  const cacheKey = (resourceType: string, resourceText: string): string =>
    buildEpubDerivedCacheKey({
      sourceFingerprint: options.sourceFingerprint,
      resourceType,
      resourceText,
      transformVersion: version,
    });

  return {
    version,
    cacheKey,
    transform(resourceType, resourceText) {
      const key = cacheKey(resourceType, resourceText);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      const transformed = sanitizeEpubResource(resourceType, resourceText);
      cache.set(key, transformed);
      return transformed;
    },
  };
}

/** 移除由阅读器注入、但不属于规范正文的展示辅助节点。 */
export function removeEpubDisplayOnlyNodes(doc: Document): void {
  doc
    .querySelectorAll(`[${EPUB_DISPLAY_ONLY_ATTRIBUTE}]`)
    .forEach((node) => node.remove());
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
