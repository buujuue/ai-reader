import { describe, expect, it, vi } from 'vitest';

import {
  createTauriEpubDerivedTocCache,
  DERIVED_TOC_CACHE_COMMANDS,
} from './tauriDerivedTocCache';
import { assertEpubDerivedTocCacheContract } from './derivedTocCacheContract';

describe('Tauri EPUB 推导目录缓存适配器', () => {
  it('通过 typed 命令读写本地派生缓存', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('{"version":"epub-derived-toc-v1"}')
      .mockResolvedValueOnce(undefined);
    const cache = createTauriEpubDerivedTocCache(invoke);

    await expect(cache.get('cache-key')).resolves.toBe(
      '{"version":"epub-derived-toc-v1"}',
    );
    await cache.set('cache-key', '{"toc":[]}');

    expect(invoke).toHaveBeenNthCalledWith(1, DERIVED_TOC_CACHE_COMMANDS.read, {
      key: 'cache-key',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, DERIVED_TOC_CACHE_COMMANDS.write, {
      key: 'cache-key',
      value: '{"toc":[]}',
    });
  });

  it('把 Rust 返回的空值视为缓存未命中', async () => {
    const cache = createTauriEpubDerivedTocCache(vi.fn().mockResolvedValue(null));

    await expect(cache.get('missing')).resolves.toBeUndefined();
  });

  it('Tauri 缓存满足与内存 Adapter 相同的缓存契约', async () => {
    const values = new Map<string, string>();
    await assertEpubDerivedTocCacheContract(() =>
      createTauriEpubDerivedTocCache(async (command, args) => {
        const key = String(args?.key ?? '');
        if (command === DERIVED_TOC_CACHE_COMMANDS.read) {
          return values.get(key);
        }
        if (command === DERIVED_TOC_CACHE_COMMANDS.write) {
          values.set(key, String(args?.value ?? ''));
          return undefined;
        }
        throw new Error(`unexpected command: ${command}`);
      }),
    );
  });
});
