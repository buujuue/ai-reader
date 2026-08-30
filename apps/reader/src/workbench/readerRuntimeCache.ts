import type { BookDocument, ReaderRuntimeResourceUsage } from '../domain/reader/bookDocument';
import type { ReadingMaterial } from '../domain/library/material';
import { formatFromSourceFileName, type MaterialFormat } from '../domain/library/materialFormat';
import { EPUB_CANONICAL_TRANSFORM_VERSION } from '../domain/reader/epubCanonical';
import { EPUB_SANITIZER_VERSION } from '../domain/reader/sanitizer';
import { MARKDOWN_PARSER_VERSION } from '../domain/reader/markdown/markdownParser';

/** Reader Runtime 缓存协议版本。改变状态机或键结构时必须递增。 */
export const READER_RUNTIME_CACHE_ALGORITHM_VERSION = 'reader-runtime-cache-v1';
/** EPUB/Markdown 解析、清洗或展示辅助节点规则的版本集合。 */
export const READER_RUNTIME_CONTENT_ALGORITHM_VERSION =
  [EPUB_CANONICAL_TRANSFORM_VERSION, MARKDOWN_PARSER_VERSION, EPUB_SANITIZER_VERSION].join('|');
const MAX_RUNTIME_TRANSITION_RECORDS = 256;

export type ReaderRuntimeCacheProfile = 'desktop' | 'tablet';
export type ReaderRuntimeCacheFormat = MaterialFormat;
export type ReaderRuntimeCacheLifecycle = 'active' | 'suspended' | 'evicted' | 'closed';

export interface ReaderRuntimeCacheKeyInput {
  viewId: string;
  materialId: string;
  contentFingerprint: string;
  documentVersion: number;
  format: MaterialFormat;
  contentAlgorithmVersion?: string;
}

/**
 * Reader Runtime 的不透明缓存键。
 *
 * ReadingView 身份必须进入键：同一本材料在两个 Editor Group 中的阅读位置、导航
 * 历史和 renderer 都是两份不同的运行时。材料与内容版本字段则防止旧正文被重用。
 */
export function buildReaderRuntimeCacheKey(input: ReaderRuntimeCacheKeyInput): string {
  return JSON.stringify({
    algorithm: READER_RUNTIME_CACHE_ALGORITHM_VERSION,
    contentAlgorithm:
      input.contentAlgorithmVersion ?? READER_RUNTIME_CONTENT_ALGORITHM_VERSION,
    viewId: input.viewId,
    materialId: input.materialId,
    contentFingerprint: input.contentFingerprint,
    documentVersion: input.documentVersion,
    format: input.format,
  });
}

export function buildReaderRuntimeCacheKeyForMaterial(
  viewId: string,
  material: ReadingMaterial,
): string {
  return buildReaderRuntimeCacheKey({
    viewId,
    materialId: material.id,
    contentFingerprint: material.fingerprint,
    documentVersion: material.documentVersion,
    format: formatFromSourceFileName(material.sourceFileName),
  });
}

export interface ReaderRuntimeCacheBudget {
  profile: ReaderRuntimeCacheProfile;
  /** 活动 Runtime 的总上限；当前最多两个 Editor Group。 */
  maxActiveRuntimes: number;
  /** 允许保留的挂起 Runtime 数量。 */
  maxSuspendedRuntimes: number;
  maxSuspendedIframes: number;
  maxSuspendedCanvases: number;
  maxSuspendedDecodedPages: number;
  maxSuspendedRangeCacheBytes: number;
  maxSuspendedEstimatedBytes: number;
}

const MIB = 1024 * 1024;

/**
 * 初始资源硬预算。PDF 暂不进入该缓存，因此缓存中的 Canvas/解码页为零；PDF 自身
 * 的活动窗口预算仍由 PdfRenderer/ADR-0033 管理。
 */
export const READER_RUNTIME_CACHE_BUDGETS: Readonly<
  Record<ReaderRuntimeCacheProfile, ReaderRuntimeCacheBudget>
> = Object.freeze({
  desktop: Object.freeze({
    profile: 'desktop',
    maxActiveRuntimes: 2,
    maxSuspendedRuntimes: 1,
    maxSuspendedIframes: 4,
    maxSuspendedCanvases: 0,
    maxSuspendedDecodedPages: 0,
    maxSuspendedRangeCacheBytes: 16 * MIB,
    maxSuspendedEstimatedBytes: 64 * MIB,
  }),
  tablet: Object.freeze({
    profile: 'tablet',
    maxActiveRuntimes: 2,
    maxSuspendedRuntimes: 1,
    maxSuspendedIframes: 2,
    maxSuspendedCanvases: 0,
    maxSuspendedDecodedPages: 0,
    maxSuspendedRangeCacheBytes: 8 * MIB,
    maxSuspendedEstimatedBytes: 32 * MIB,
  }),
});

export function detectReaderRuntimeCacheProfile(): ReaderRuntimeCacheProfile {
  if (typeof window === 'undefined') return 'desktop';
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarsePointer || window.innerWidth < 800 ? 'tablet' : 'desktop';
}

export function getReaderRuntimeCacheBudget(
  profile: ReaderRuntimeCacheProfile = detectReaderRuntimeCacheProfile(),
): ReaderRuntimeCacheBudget {
  return READER_RUNTIME_CACHE_BUDGETS[profile];
}

export interface ReaderRuntimeCacheEntry<T = BookDocument> {
  viewId: string;
  materialId: string;
  format: ReaderRuntimeCacheFormat;
  key: string;
  document: T;
  usage: ReaderRuntimeResourceUsage;
  state: 'active' | 'suspended';
  lastUsedAt: number;
}

export type ReaderRuntimeCacheMissReason = 'not-found' | 'key-mismatch' | 'unsupported-format';

export type ReaderRuntimeCacheLookup<T = BookDocument> =
  | { kind: 'hit'; entry: ReaderRuntimeCacheEntry<T> }
  | { kind: 'miss'; reason: ReaderRuntimeCacheMissReason; invalidated?: ReaderRuntimeCacheEntry<T> };

export interface ReaderRuntimeCacheSuspendResult<T = BookDocument> {
  admitted: boolean;
  reason: 'admitted' | 'unsupported-format' | 'not-ready' | 'resource-budget';
  evicted: ReaderRuntimeCacheEntry<T>[];
}

export interface ReaderRuntimeCacheDiagnostics {
  profile: ReaderRuntimeCacheProfile;
  budget: ReaderRuntimeCacheBudget;
  hits: number;
  misses: number;
  admissions: number;
  rejectedAdmissions: number;
  evictions: number;
  invalidations: number;
  transitions: Array<{
    viewId: string;
    from: ReaderRuntimeCacheLifecycle | null;
    to: ReaderRuntimeCacheLifecycle;
    reason: string;
  }>;
  entries: Array<{
    viewId: string;
    materialId: string;
    format: ReaderRuntimeCacheFormat;
    state: 'active' | 'suspended';
    usage: ReaderRuntimeResourceUsage;
  }>;
}

export interface ReaderRuntimeCacheOptions<T = BookDocument> {
  profile?: ReaderRuntimeCacheProfile;
  budget?: ReaderRuntimeCacheBudget;
  now?: () => number;
  isReady?: (document: T) => boolean;
}

/**
 * 只管理活对象，不负责调用 `close()`。这样缓存可以把 eviction/invalidation 作为
 * 状态转换返回给 Reader Runtime，由唯一的 Runtime Store 负责关闭对象，避免重复关闭。
 */
export class ReaderRuntimeCache<T = BookDocument> {
  private readonly budget: ReaderRuntimeCacheBudget;
  private readonly now: () => number;
  private readonly isReady: (document: T) => boolean;
  private readonly entries = new Map<string, ReaderRuntimeCacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private admissions = 0;
  private rejectedAdmissions = 0;
  private evictions = 0;
  private invalidations = 0;
  private readonly transitions: ReaderRuntimeCacheDiagnostics['transitions'] = [];

  constructor(options: ReaderRuntimeCacheOptions<T> = {}) {
    this.budget = options.budget ?? getReaderRuntimeCacheBudget(options.profile);
    this.now = options.now ?? (() => Date.now());
    this.isReady = options.isReady ?? (() => true);
  }

  getBudget(): ReaderRuntimeCacheBudget {
    return this.budget;
  }

  registerActive(entry: Omit<ReaderRuntimeCacheEntry<T>, 'state' | 'lastUsedAt'>): void {
    // PDF/unknown Runtime 不进入该缓存，避免“活动登记”留下一个看似可命中的条目。
    if (entry.format !== 'epub' && entry.format !== 'markdown') return;
    const existing = this.entries.get(entry.viewId);
    if (existing?.document !== entry.document) {
      this.entries.delete(entry.viewId);
    }
    this.recordTransition(entry.viewId, existing?.state ?? null, 'active', 'register');
    this.entries.set(entry.viewId, {
      ...entry,
      state: 'active',
      lastUsedAt: this.now(),
    });
  }

  activate(viewId: string, key: string): ReaderRuntimeCacheLookup<T> {
    const entry = this.entries.get(viewId);
    if (!entry) {
      this.misses += 1;
      return { kind: 'miss', reason: 'not-found' };
    }
    if (entry.key !== key) {
      this.entries.delete(viewId);
      this.recordTransition(viewId, entry.state, 'evicted', 'key-mismatch');
      this.misses += 1;
      this.invalidations += 1;
      return { kind: 'miss', reason: 'key-mismatch', invalidated: entry };
    }
    this.recordTransition(viewId, entry.state, 'active', 'cache-hit');
    entry.state = 'active';
    entry.lastUsedAt = this.now();
    this.hits += 1;
    return { kind: 'hit', entry };
  }

  suspend(
    entry: Omit<ReaderRuntimeCacheEntry<T>, 'state' | 'lastUsedAt'>,
  ): ReaderRuntimeCacheSuspendResult<T> {
    if (entry.format !== 'epub' && entry.format !== 'markdown') {
      this.rejectedAdmissions += 1;
      return { admitted: false, reason: 'unsupported-format', evicted: [] };
    }
    if (!this.isReady(entry.document)) {
      this.rejectedAdmissions += 1;
      return { admitted: false, reason: 'not-ready', evicted: [] };
    }
    if (!fitsBudget(entry.usage, this.budget)) {
      this.rejectedAdmissions += 1;
      return { admitted: false, reason: 'resource-budget', evicted: [] };
    }

    const existing = this.entries.get(entry.viewId);
    this.entries.set(entry.viewId, {
      ...entry,
      state: 'suspended',
      lastUsedAt: this.now(),
    });
    this.recordTransition(entry.viewId, existing?.state ?? 'active', 'suspended', 'suspend');
    this.admissions += 1;
    const evicted: ReaderRuntimeCacheEntry<T>[] = [];
    while (!fitsSuspendedBudget(this.entries, this.budget)) {
      const oldest = [...this.entries.values()]
        .filter((candidate) => candidate.state === 'suspended')
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!oldest) break;
      this.entries.delete(oldest.viewId);
      this.recordTransition(oldest.viewId, oldest.state, 'evicted', 'lru');
      evicted.push(oldest);
      this.evictions += 1;
    }
    const admitted = this.entries.get(entry.viewId)?.document === entry.document;
    return {
      admitted,
      reason: admitted ? 'admitted' : 'resource-budget',
      evicted,
    };
  }

  remove(viewId: string): ReaderRuntimeCacheEntry<T> | undefined {
    const entry = this.entries.get(viewId);
    this.entries.delete(viewId);
    if (entry) this.recordTransition(viewId, entry.state, 'closed', 'remove');
    return entry;
  }

  invalidateMaterial(
    materialId: string,
    options: { includeActive?: boolean } = {},
  ): ReaderRuntimeCacheEntry<T>[] {
    const includeActive = options.includeActive ?? true;
    const invalidated: ReaderRuntimeCacheEntry<T>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.materialId !== materialId || (!includeActive && entry.state === 'active')) continue;
      this.entries.delete(entry.viewId);
      this.recordTransition(entry.viewId, entry.state, 'evicted', 'material-invalidated');
      invalidated.push(entry);
      this.invalidations += 1;
    }
    return invalidated;
  }

  getEntries(): ReaderRuntimeCacheEntry<T>[] {
    return [...this.entries.values()];
  }

  getDiagnostics(): ReaderRuntimeCacheDiagnostics {
    return {
      profile: this.budget.profile,
      budget: this.budget,
      hits: this.hits,
      misses: this.misses,
      admissions: this.admissions,
      rejectedAdmissions: this.rejectedAdmissions,
      evictions: this.evictions,
      invalidations: this.invalidations,
      transitions: [...this.transitions],
      entries: this.getEntries().map((entry) => ({
        viewId: entry.viewId,
        materialId: entry.materialId,
        format: entry.format,
        state: entry.state,
        usage: entry.usage,
      })),
    };
  }

  clear(): ReaderRuntimeCacheEntry<T>[] {
    const existing = this.getEntries();
    for (const entry of existing) {
      this.recordTransition(entry.viewId, entry.state, 'closed', 'cache-cleared');
    }
    this.entries.clear();
    return existing;
  }

  /** 测量/测试开始新一轮时清理对象和计数；对象的 close 仍由调用方负责。 */
  reset(): ReaderRuntimeCacheEntry<T>[] {
    const existing = this.clear();
    this.hits = 0;
    this.misses = 0;
    this.admissions = 0;
    this.rejectedAdmissions = 0;
    this.evictions = 0;
    this.invalidations = 0;
    this.transitions.length = 0;
    return existing;
  }

  private recordTransition(
    viewId: string,
    from: ReaderRuntimeCacheLifecycle | null,
    to: ReaderRuntimeCacheLifecycle,
    reason: string,
  ): void {
    this.transitions.push({ viewId, from, to, reason });
    if (this.transitions.length > MAX_RUNTIME_TRANSITION_RECORDS) this.transitions.shift();
  }
}

export function estimateReaderRuntimeResourceUsage(
  document: BookDocument,
): ReaderRuntimeResourceUsage {
  const measured = document.getRuntimeResourceUsage?.();
  if (measured) return normalizeUsage(measured);

  const contentDocs = document.getContentDocs();
  let canvasCount = 0;
  let canvasBytes = 0;
  for (const contentDocument of contentDocs) {
    for (const canvas of contentDocument.querySelectorAll('canvas')) {
      canvasCount += 1;
      canvasBytes += Math.max(0, canvas.width) * Math.max(0, canvas.height) * 4;
    }
  }
  return normalizeUsage({
    iframeCount: contentDocs.length,
    canvasCount,
    decodedPageCount: 0,
    rangeCacheBytes: 0,
    estimatedBytes: canvasBytes,
  });
}

function normalizeUsage(usage: ReaderRuntimeResourceUsage): ReaderRuntimeResourceUsage {
  return {
    iframeCount: Math.max(0, Math.floor(usage.iframeCount)),
    canvasCount: Math.max(0, Math.floor(usage.canvasCount)),
    decodedPageCount: Math.max(0, Math.floor(usage.decodedPageCount)),
    rangeCacheBytes: Math.max(0, Math.floor(usage.rangeCacheBytes)),
    estimatedBytes: Math.max(0, Math.floor(usage.estimatedBytes)),
  };
}

function fitsBudget(
  usage: ReaderRuntimeResourceUsage,
  budget: ReaderRuntimeCacheBudget,
): boolean {
  return (
    usage.iframeCount <= budget.maxSuspendedIframes &&
    usage.canvasCount <= budget.maxSuspendedCanvases &&
    usage.decodedPageCount <= budget.maxSuspendedDecodedPages &&
    usage.rangeCacheBytes <= budget.maxSuspendedRangeCacheBytes &&
    usage.estimatedBytes <= budget.maxSuspendedEstimatedBytes
  );
}

function fitsSuspendedBudget<T>(
  entries: Map<string, ReaderRuntimeCacheEntry<T>>,
  budget: ReaderRuntimeCacheBudget,
): boolean {
  const suspended = [...entries.values()].filter((entry) => entry.state === 'suspended');
  if (suspended.length > budget.maxSuspendedRuntimes) return false;
  const total = suspended.reduce(
    (sum, entry) => ({
      iframeCount: sum.iframeCount + entry.usage.iframeCount,
      canvasCount: sum.canvasCount + entry.usage.canvasCount,
      decodedPageCount: sum.decodedPageCount + entry.usage.decodedPageCount,
      rangeCacheBytes: sum.rangeCacheBytes + entry.usage.rangeCacheBytes,
      estimatedBytes: sum.estimatedBytes + entry.usage.estimatedBytes,
    }),
    { iframeCount: 0, canvasCount: 0, decodedPageCount: 0, rangeCacheBytes: 0, estimatedBytes: 0 },
  );
  return fitsBudget(total, budget);
}
