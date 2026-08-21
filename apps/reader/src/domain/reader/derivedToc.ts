import type { Toc, TocItem } from './toc';
import { sanitizeEpubContent } from './sanitizer';

/** 推导目录算法版本；任何层级、标题筛选或目标规则变化都必须递增。 */
export const EPUB_DERIVED_TOC_ALGORITHM_VERSION = 'epub-derived-toc-v1';

export interface DerivedTocBudget {
  /** 最多读取的 spine 章节数。 */
  maxSections: number;
  /** 单个章节最多送入标题解析的字符数。 */
  maxSectionTextCharacters: number;
  /** 整本书最多送入标题解析的字符数。 */
  maxTotalTextCharacters: number;
  /** 最多生成的目录节点数。 */
  maxNodes: number;
  /** 允许的标题层级深度(h1 为 1)。 */
  maxDepth: number;
  /** 单个目录标签最多保留的字符数。 */
  maxLabelCharacters: number;
}

/** 推导目录的硬预算，避免异常 EPUB 让目录扫描无限扩张。 */
export const DEFAULT_DERIVED_TOC_BUDGET: Readonly<DerivedTocBudget> = Object.freeze({
  maxSections: 128,
  maxSectionTextCharacters: 512 * 1024,
  maxTotalTextCharacters: 4 * 1024 * 1024,
  maxNodes: 512,
  maxDepth: 6,
  maxLabelCharacters: 256,
});

export interface DerivedTocSectionContent {
  /** Foliate 解析后的包内章节 href，不含 fragment。 */
  href: string;
  /** 章节的规范 XHTML/HTML 文本。 */
  text: string;
}

export interface DerivedTocSection {
  /** Foliate 解析后的包内章节 href，不含 fragment。 */
  href: string;
  /** 延迟读取章节正文；单章失败只跳过该章。 */
  loadText: () => Promise<string | null>;
}

/**
 * 推导目录专用的异步缓存边界。持久化实现由平台 Repository 提供，
 * 本模块只读写带版本的目录 JSON，不接触 localStorage、文件路径或数据库。
 */
export interface EpubDerivedTocCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface DeriveEpubTocOptions {
  /** 完整内容指纹，作为 `bookHash` 使用。 */
  sourceFingerprint?: string;
  /** 仅保存小型目录 JSON，不保存原书章节文本。 */
  cache?: EpubDerivedTocCache;
  budget?: Partial<DerivedTocBudget>;
}

interface DerivedTocCacheEnvelope {
  version: string;
  sourceFingerprint: string;
  toc: Toc;
}

/** 生成只依赖书籍指纹和算法版本的本地派生缓存键。 */
export function buildDerivedTocCacheKey(
  sourceFingerprint: string,
  algorithmVersion = EPUB_DERIVED_TOC_ALGORITHM_VERSION,
): string {
  return ['epub-derived-toc', algorithmVersion, sourceFingerprint]
    .map((value) => encodeURIComponent(value))
    .join(':');
}

/** 判断原生目录是否至少包含一个可导航的包内目标。 */
export function hasNavigableToc(
  items: unknown,
  isNavigableHref: (href: string) => boolean = (href) => href.trim().length > 0,
): boolean {
  if (!Array.isArray(items)) {
    return false;
  }
  return items.some((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    const candidate = item as { href?: unknown; subitems?: unknown };
    return (
      (typeof candidate.href === 'string' && isNavigableHref(candidate.href)) ||
      hasNavigableToc(candidate.subitems, isNavigableHref)
    );
  });
}

/** 判断原生目录是否完整可用；无 href 的父节点必须拥有完整可用的子节点。 */
export function isUsableToc(
  items: unknown,
  isNavigableHref: (href: string) => boolean = (href) => href.trim().length > 0,
): boolean {
  if (!Array.isArray(items) || items.length === 0) {
    return false;
  }
  return items.every((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    const candidate = item as { href?: unknown; subitems?: unknown };
    const href = typeof candidate.href === 'string' ? candidate.href : '';
    const hasValidHref = isNavigableHref(href);
    const children = candidate.subitems;
    const hasUsableChildren =
      Array.isArray(children) && isUsableToc(children, isNavigableHref);
    const childrenAreComplete =
      !Array.isArray(children) || children.length === 0 || hasUsableChildren;
    return childrenAreComplete && (hasValidHref || hasUsableChildren);
  });
}

/**
 * 从已读取的章节文本构造临时目录。
 *
 * 该函数只解析 h1-h6，不写回章节 DOM；无 id 的标题退回到章节 href，
 * 因而即便不能定位到标题本身，也始终拥有一个稳定、可导航的章节目标。
 */
export function buildDerivedToc(
  sections: readonly DerivedTocSectionContent[],
  budgetOptions: Partial<DerivedTocBudget> = {},
): Toc {
  const budget = normalizeBudget(budgetOptions);
  const root: TocItem[] = [];
  const stack: Array<{ level: number; subitems: TocItem[] }> = [
    { level: 0, subitems: root },
  ];
  let nodeCount = 0;
  let totalCharacters = 0;

  for (const section of sections.slice(0, budget.maxSections)) {
    if (!isSafePackageHref(section.href) || !section.text) {
      continue;
    }
    if (totalCharacters >= budget.maxTotalTextCharacters) {
      break;
    }
    const remaining = budget.maxTotalTextCharacters - totalCharacters;
    const text = section.text.slice(
      0,
      Math.min(budget.maxSectionTextCharacters, remaining),
    );
    totalCharacters += text.length;
    const doc = parseHeadingDocument(text);
    if (!doc) {
      continue;
    }

    const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    for (const heading of headings) {
      if (nodeCount >= budget.maxNodes) {
        return root;
      }
      if (isExcludedHeading(heading)) {
        continue;
      }

      const level = Number(heading.localName.slice(1));
      if (!Number.isInteger(level) || level < 1 || level > budget.maxDepth) {
        continue;
      }
      const label = normalizeHeadingLabel(heading.textContent ?? '', budget.maxLabelCharacters);
      if (!label) {
        continue;
      }

      const fragment = readStableFragment(heading);
      const item: TocItem = {
        label,
        href: fragment ? `${section.href}#${fragment}` : section.href,
        source: 'derived',
        subitems: [],
      };
      while (stack.length > 1 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }
      stack[stack.length - 1]!.subitems.push(item);
      stack.push({ level, subitems: item.subitems! });
      nodeCount += 1;
    }
  }

  return pruneEmptySubitems(root);
}

/**
 * 受预算读取章节并构造临时目录。缓存损坏、章节损坏或标题解析失败都只
 * 影响目录，不会让 BookDocument.open() 失败。
 */
export async function deriveEpubToc(
  sections: readonly DerivedTocSection[],
  options: DeriveEpubTocOptions = {},
): Promise<Toc> {
  const budget = normalizeBudget(options.budget ?? {});
  const sourceFingerprint = options.sourceFingerprint;
  const cacheKey = sourceFingerprint
    ? buildDerivedTocCacheKey(sourceFingerprint)
    : null;

  if (sourceFingerprint && cacheKey && options.cache) {
    const cached = await readCachedToc(options.cache, cacheKey, sourceFingerprint, budget);
    if (cached) {
      return cached;
    }
  }

  const contents: DerivedTocSectionContent[] = [];
  let totalCharacters = 0;
  for (const section of sections.slice(0, budget.maxSections)) {
    if (totalCharacters >= budget.maxTotalTextCharacters) {
      break;
    }
    if (!isSafePackageHref(section.href)) {
      continue;
    }

    let text: string | null;
    try {
      text = await section.loadText();
    } catch {
      continue;
    }
    if (typeof text !== 'string' || !text) {
      continue;
    }

    const remaining = budget.maxTotalTextCharacters - totalCharacters;
    const limitedText = text.slice(0, Math.min(budget.maxSectionTextCharacters, remaining));
    if (!limitedText) {
      break;
    }
    totalCharacters += limitedText.length;
    contents.push({ href: section.href, text: limitedText });
  }

  const toc = buildDerivedToc(contents, budget);
  if (sourceFingerprint && cacheKey && options.cache) {
    const envelope: DerivedTocCacheEnvelope = {
      version: EPUB_DERIVED_TOC_ALGORITHM_VERSION,
      sourceFingerprint,
      toc,
    };
    try {
      await options.cache.set(cacheKey, JSON.stringify(envelope));
    } catch {
      // 派生缓存不可写不应影响正文阅读或目录显示。
    }
  }
  return toc;
}

/** 仅把字符串目录缓存作为合法的推导目录读取，损坏数据自然触发重建。 */
async function readCachedToc(
  cache: EpubDerivedTocCache,
  key: string,
  sourceFingerprint: string,
  budget: DerivedTocBudget,
): Promise<Toc | null> {
  let raw: string | undefined;
  try {
    raw = await cache.get(key);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<DerivedTocCacheEnvelope>;
    if (
      value.version !== EPUB_DERIVED_TOC_ALGORITHM_VERSION ||
      value.sourceFingerprint !== sourceFingerprint
    ) {
      return null;
    }
    return validateCachedToc(value.toc, budget);
  } catch {
    return null;
  }
}

function validateCachedToc(value: unknown, budget: DerivedTocBudget): Toc | null {
  if (!Array.isArray(value)) {
    return null;
  }
  let nodeCount = 0;
  const visit = (items: unknown[], depth: number): TocItem[] | null => {
    if (depth > budget.maxDepth) {
      return null;
    }
    const result: TocItem[] = [];
    for (const candidate of items) {
      if (!candidate || typeof candidate !== 'object') {
        return null;
      }
      const item = candidate as Partial<TocItem>;
      if (
        typeof item.label !== 'string' ||
        !item.label.trim() ||
        item.label.length > budget.maxLabelCharacters ||
        typeof item.href !== 'string' ||
        !item.href.trim() ||
        !isSafePackageHref(item.href.split('#', 1)[0] ?? '') ||
        item.source !== 'derived'
      ) {
        return null;
      }
      nodeCount += 1;
      if (nodeCount > budget.maxNodes) {
        return null;
      }
      let subitems: TocItem[] | null = null;
      if (item.subitems !== null) {
        if (!Array.isArray(item.subitems)) {
          return null;
        }
        const nested = visit(item.subitems, depth + 1);
        if (!nested) {
          return null;
        }
        subitems = nested.length > 0 ? nested : null;
      }
      result.push({
        label: item.label,
        href: item.href,
        source: 'derived',
        subitems,
      });
    }
    return result;
  };
  return visit(value, 1);
}

/** 浏览器降级与测试使用的内存缓存；Tauri 运行时由平台 Repository 替换。 */
export function createEpubDerivedTocCache(): EpubDerivedTocCache {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
  };
}

function normalizeBudget(options: Partial<DerivedTocBudget>): DerivedTocBudget {
  const positive = (value: number | undefined, fallback: number): number =>
    Number.isInteger(value) && value! > 0 ? value! : fallback;
  return {
    maxSections: positive(options.maxSections, DEFAULT_DERIVED_TOC_BUDGET.maxSections),
    maxSectionTextCharacters: positive(
      options.maxSectionTextCharacters,
      DEFAULT_DERIVED_TOC_BUDGET.maxSectionTextCharacters,
    ),
    maxTotalTextCharacters: positive(
      options.maxTotalTextCharacters,
      DEFAULT_DERIVED_TOC_BUDGET.maxTotalTextCharacters,
    ),
    maxNodes: positive(options.maxNodes, DEFAULT_DERIVED_TOC_BUDGET.maxNodes),
    maxDepth: Math.min(6, positive(options.maxDepth, DEFAULT_DERIVED_TOC_BUDGET.maxDepth)),
    maxLabelCharacters: positive(
      options.maxLabelCharacters,
      DEFAULT_DERIVED_TOC_BUDGET.maxLabelCharacters,
    ),
  };
}

function parseHeadingDocument(text: string): Document | null {
  try {
    const safeText = sanitizeEpubContent(text);
    const xhtml = new DOMParser().parseFromString(safeText, 'application/xhtml+xml');
    if (xhtml.documentElement && xhtml.getElementsByTagName('parsererror').length === 0) {
      return xhtml;
    }
    const html = new DOMParser().parseFromString(safeText, 'text/html');
    return html.documentElement ? html : null;
  } catch {
    return null;
  }
}

function isExcludedHeading(heading: Element): boolean {
  return !!heading.closest('nav, aside, footer, [hidden], [aria-hidden="true"]');
}

function normalizeHeadingLabel(value: string, maxCharacters: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxCharacters).trim();
}

function readStableFragment(heading: Element): string | null {
  const fragment = heading.getAttribute('id')?.trim() || heading.getAttribute('name')?.trim();
  if (!fragment || /[#\u0000-\u001f]/.test(fragment)) {
    return null;
  }
  return fragment;
}

function isSafePackageHref(href: string): boolean {
  return !!href.trim() && !/^(?:[a-z][a-z\d+.-]*:|\/\/|[\\/])/i.test(href.trim());
}

function pruneEmptySubitems(items: TocItem[]): Toc {
  return items.map((item) => ({
    label: item.label,
    href: item.href,
    source: 'derived',
    subitems: item.subitems && item.subitems.length > 0
      ? pruneEmptySubitems(item.subitems)
      : null,
  }));
}
