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
    expect(key).toContain('reader-runtime-cache-v1');
    expect(buildReaderRuntimeCacheKey({ ...base, viewId: 'view-b' })).not.toBe(key);
    expect(buildReaderRuntimeCacheKey({ ...base, materialId: 'material-b' })).not.toBe(key);
    expect(buildReaderRuntimeCacheKey({ ...base, contentFingerprint: 'fingerprint-b' })).not.toBe(key);
    expect(buildReaderRuntimeCacheKey({ ...base, documentVersion: 1 })).not.toBe(key);
    expect(buildReaderRuntimeCacheKey({ ...base, contentAlgorithmVersion: 'future-v2' })).not.toBe(key);
  });

  it('只准入 EPUB/Markdown，PDF 明确拒绝缓存', () => {
    const cache = new ReaderRuntimeCache<{ id: string }>({ budget: makeBudget() });
    const result = cache.suspend({ ...makeEntry('pdf'), format: 'pdf' });
    expect(result).toEqual({ admitted: false, reason: 'unsupported-format', evicted: [] });
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
