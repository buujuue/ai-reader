import { describe, expect, it } from 'vitest';

import {
  buildReaderRuntimeCacheKey,
  READER_RUNTIME_CACHE_BUDGETS,
  ReaderRuntimeCache,
} from './readerRuntimeCache';

function makeBudget(overrides: Partial<typeof READER_RUNTIME_CACHE_BUDGETS.desktop> = {}) {
  return { ...READER_RUNTIME_CACHE_BUDGETS.desktop, ...overrides };
}

function makeEntry(id: string, usage = {
  iframeCount: 1,
  canvasCount: 0,
  decodedPageCount: 0,
  rangeCacheBytes: 0,
  estimatedBytes: 0,
}) {
  return {
    viewId: id,
    materialId: `material-${id}`,
    format: 'epub' as const,
    key: `key-${id}`,
    document: { id },
    usage,
  };
}

describe('ReaderRuntimeCache', () => {
  it('默认把三个 ReadingView Runtime 作为 resident 硬上限', () => {
    expect(READER_RUNTIME_CACHE_BUDGETS.desktop).toMatchObject({
      maxResidentRuntimes: 3,
      maxActiveRuntimes: 2,
      maxSuspendedRuntimes: 2,
      maxSuspendedCanvases: 2,
      maxSuspendedDecodedPages: 2,
    });
    expect(READER_RUNTIME_CACHE_BUDGETS.tablet).toMatchObject({
      maxResidentRuntimes: 3,
      maxActiveRuntimes: 2,
      maxSuspendedRuntimes: 2,
      maxSuspendedCanvases: 1,
      maxSuspendedDecodedPages: 1,
    });
  });

  it('A→B→C 保留三个按 ReadingView 隔离的 resident Runtime', () => {
    let now = 0;
    const cache = new ReaderRuntimeCache<{ id: string }>({
      budget: makeBudget(),
      now: () => now,
    });
    const first = makeEntry('first');
    const second = makeEntry('second');
    const third = makeEntry('third');

    expect(cache.suspend(first).admitted).toBe(true);
    now = 1;
    expect(cache.suspend(second).admitted).toBe(true);
    now = 2;
    expect(cache.registerActive(third)).toEqual([]);

    expect(cache.getEntries()).toHaveLength(3);
    expect(cache.getEntries().filter((entry) => entry.state === 'suspended')).toHaveLength(2);
    expect(cache.activate('first', 'key-first').kind).toBe('hit');
    expect(cache.getEntries().find((entry) => entry.viewId === 'first')?.state).toBe('active');
  });

  it('新增第四个 resident Runtime 时只按 LRU 淘汰挂起对象', () => {
    let now = 0;
    const cache = new ReaderRuntimeCache<{ id: string }>({
      budget: makeBudget(),
      now: () => now,
    });
    expect(cache.suspend(makeEntry('a')).admitted).toBe(true);
    now = 1;
    expect(cache.suspend(makeEntry('b')).admitted).toBe(true);
    now = 2;
    cache.registerActive(makeEntry('c'));
    now = 3;
    const result = cache.suspend(makeEntry('d'));

    expect(result.admitted).toBe(true);
    expect(result.evicted.map((entry) => entry.viewId)).toEqual(['a']);
    expect(cache.getEntries()).toHaveLength(3);
    expect(cache.getEntries().map((entry) => entry.viewId)).toEqual(['b', 'c', 'd']);
    expect(cache.getEntries().find((entry) => entry.viewId === 'c')?.state).toBe('active');
  });

  it('同一 View 注册新文档时返回旧条目供所有者安全关闭', () => {
    const cache = new ReaderRuntimeCache<{ id: string }>({ budget: makeBudget() });
    const previous = makeEntry('same-view');
    const replacement = { ...makeEntry('same-view'), key: 'replacement-key' };

    cache.registerActive(previous);
    const evicted = cache.registerActive(replacement);

    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.document).toBe(previous.document);
    expect(cache.getEntries()[0]?.document).toBe(replacement.document);
  });

  it('缓存键隔离视图、材料、完整指纹、文档版本和算法版本', () => {
    const base = {
      viewId: 'view-a',
      materialId: 'material-a',
      contentFingerprint: 'fingerprint-a',
      documentVersion: 0,
      format: 'epub' as const,
    };
    const key = buildReaderRuntimeCacheKey(base);
    expect(key).toContain('view-a');
    expect(key).toContain('material-a');
    expect(key).toContain('fingerprint-a');
    expect(key).toContain('reader-runtime-cache-v2');
    expect(buildReaderRuntimeCacheKey({ ...base, viewId: 'view-b' })).not.toBe(key);
    expect(buildReaderRuntimeCacheKey({ ...base, materialId: 'material-b' })).not.toBe(key);
    expect(buildReaderRuntimeCacheKey({ ...base, contentFingerprint: 'fingerprint-b' })).not.toBe(key);
    expect(buildReaderRuntimeCacheKey({ ...base, documentVersion: 1 })).not.toBe(key);
    expect(buildReaderRuntimeCacheKey({ ...base, contentAlgorithmVersion: 'future-v2' })).not.toBe(key);
  });

  it('PDF 也可在当前页资源预算内进入缓存', () => {
    const cache = new ReaderRuntimeCache<{ id: string }>({ budget: makeBudget() });
    const result = cache.suspend({ ...makeEntry('pdf'), format: 'pdf' });
    expect(result).toEqual({ admitted: true, reason: 'admitted', evicted: [] });
    expect(cache.getEntries()[0]?.format).toBe('pdf');
  });

  it('PDF 挂起时超过 Canvas 或解码页预算会安全拒绝', () => {
    const cache = new ReaderRuntimeCache<{ id: string }>({
      budget: makeBudget({ maxSuspendedCanvases: 1, maxSuspendedDecodedPages: 1 }),
    });
    const result = cache.suspend({
      ...makeEntry('large-pdf'),
      format: 'pdf',
      usage: {
        iframeCount: 0,
        canvasCount: 2,
        decodedPageCount: 2,
        rangeCacheBytes: 0,
        estimatedBytes: 1024,
      },
    });
    expect(result).toMatchObject({ admitted: false, reason: 'resource-budget' });
    expect(cache.getEntries()).toHaveLength(0);
  });

  it('挂起时仍有在途范围读取会安全退化为重建', () => {
    const cache = new ReaderRuntimeCache<{ id: string }>({
      budget: makeBudget({ maxSuspendedInFlightRangeReads: 0 }),
    });
    const result = cache.suspend({
      ...makeEntry('pdf-in-flight'),
      format: 'pdf',
      usage: {
        iframeCount: 0,
        canvasCount: 1,
        decodedPageCount: 1,
        rangeCacheBytes: 0,
        estimatedBytes: 1024,
        inFlightRangeReadCount: 1,
      },
    });

    expect(result).toMatchObject({ admitted: false, reason: 'resource-budget' });
    expect(cache.getEntries()).toHaveLength(0);
  });

  it('超出挂起数量时按最旧使用时间 LRU 淘汰', () => {
    let now = 0;
    const cache = new ReaderRuntimeCache<{ id: string }>({
      budget: makeBudget({ maxSuspendedRuntimes: 1 }),
      now: () => now,
    });
    const first = makeEntry('first');
    const second = makeEntry('second');

    expect(cache.suspend(first).admitted).toBe(true);
    now = 1;
    const result = cache.suspend(second);

    expect(result.admitted).toBe(true);
    expect(result.evicted.map((entry) => entry.viewId)).toEqual(['first']);
    expect(cache.activate('second', 'key-second').kind).toBe('hit');
    expect(cache.activate('first', 'key-first')).toMatchObject({
      kind: 'miss',
      reason: 'not-found',
    });
    cache.remove('second');
    expect(cache.getDiagnostics().transitions.map((transition) => transition.to)).toEqual(
      expect.arrayContaining(['suspended', 'evicted', 'active', 'closed']),
    );
  });

  it('任何单项或累计资源超过硬预算都不会留下挂起对象', () => {
    const cache = new ReaderRuntimeCache<{ id: string }>({
      budget: makeBudget({ maxSuspendedIframes: 1, maxSuspendedEstimatedBytes: 4 }),
    });
    const result = cache.suspend(makeEntry('too-large', {
      iframeCount: 2,
      canvasCount: 0,
      decodedPageCount: 0,
      rangeCacheBytes: 0,
      estimatedBytes: 5,
    }));
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe('resource-budget');
    expect(cache.getEntries()).toHaveLength(0);
  });

  it('累计资源超限时保留新条目并明确记录被 LRU 淘汰的旧条目', () => {
    let now = 0;
    const cache = new ReaderRuntimeCache<{ id: string }>({
      budget: makeBudget({ maxSuspendedEstimatedBytes: 6 }),
      now: () => now,
    });
    const first = makeEntry('first-budget', {
      iframeCount: 0,
      canvasCount: 0,
      decodedPageCount: 0,
      rangeCacheBytes: 0,
      estimatedBytes: 4,
    });
    const second = makeEntry('second-budget', {
      iframeCount: 0,
      canvasCount: 0,
      decodedPageCount: 0,
      rangeCacheBytes: 0,
      estimatedBytes: 4,
    });

    expect(cache.suspend(first).admitted).toBe(true);
    now = 1;
    const result = cache.suspend(second);

    expect(result).toMatchObject({
      admitted: true,
      reason: 'admitted',
      evicted: [{ viewId: 'first-budget' }],
    });
    expect(cache.getEntries().map((entry) => entry.viewId)).toEqual(['second-budget']);
    expect(cache.getDiagnostics().transitions).toContainEqual({
      viewId: 'first-budget',
      from: 'suspended',
      to: 'evicted',
      reason: 'lru',
    });
  });

  it('单项超预算拒绝和缓存 miss 都提供可定位的结构化诊断', () => {
    const cache = new ReaderRuntimeCache<{ id: string }>({
      budget: makeBudget({ maxSuspendedEstimatedBytes: 4 }),
    });
    const rejected = makeEntry('too-large-diagnostic', {
      iframeCount: 0,
      canvasCount: 0,
      decodedPageCount: 0,
      rangeCacheBytes: 0,
      estimatedBytes: 5,
    });

    expect(cache.suspend(rejected)).toMatchObject({
      admitted: false,
      reason: 'resource-budget',
    });
    expect(cache.activate('missing-view', 'missing-key')).toEqual({
      kind: 'miss',
      reason: 'not-found',
    });

    const diagnostics = cache.getDiagnostics();
    expect(diagnostics.admissionRejections).toEqual([
      {
        viewId: 'too-large-diagnostic',
        reason: 'resource-budget',
        usage: { ...rejected.usage, inFlightRangeReadCount: 0 },
      },
    ]);
    expect(diagnostics.lookupMisses).toEqual([
      {
        viewId: 'missing-view',
        reason: 'not-found',
      },
    ]);
  });

  it('命中必须使用精确键，键变化会返回失效对象供上层关闭', () => {
    const cache = new ReaderRuntimeCache<{ id: string }>({ budget: makeBudget() });
    const entry = makeEntry('view-a');
    cache.suspend(entry);

    const result = cache.activate('view-a', 'different-key');
    expect(result.kind).toBe('miss');
    if (result.kind === 'miss') {
      expect(result.reason).toBe('key-mismatch');
      expect(result.invalidated?.document).toBe(entry.document);
    }
    expect(cache.getEntries()).toHaveLength(0);
  });

  it('回收站失效只移除挂起条目并保留活动条目', () => {
    const cache = new ReaderRuntimeCache<{ id: string }>({ budget: makeBudget() });
    const active = makeEntry('active');
    const suspended = makeEntry('suspended');

    cache.registerActive(active);
    cache.suspend(suspended);

    const invalidated = cache.invalidateMaterial('material-active', { includeActive: false });

    expect(invalidated).toHaveLength(0);
    expect(cache.getEntries().map((entry) => entry.viewId)).toEqual(['active', 'suspended']);
    expect(cache.invalidateMaterial('material-suspended', { includeActive: false })).toHaveLength(1);
    expect(cache.getEntries().map((entry) => entry.viewId)).toEqual(['active']);
  });
});
