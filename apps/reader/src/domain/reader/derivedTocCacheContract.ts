import type { EpubDerivedTocCache } from './derivedToc';

/**
 * 内存与 Tauri 缓存 Adapter 共用的最小行为契约；调用方用测试框架包装断言。
 * 这样两条运行时路径都验证 miss、写入、覆盖与 key 隔离语义。
 */
export async function assertEpubDerivedTocCacheContract(
  createCache: () => EpubDerivedTocCache,
): Promise<void> {
  const cache = createCache();
  if ((await cache.get('missing')) !== undefined) {
    throw new Error('missing key must return undefined');
  }
  await cache.set('book-a', '{"toc":["a"]}');
  if ((await cache.get('book-a')) !== '{"toc":["a"]}') {
    throw new Error('written value must be readable');
  }
  await cache.set('book-a', '{"toc":["updated"]}');
  if ((await cache.get('book-a')) !== '{"toc":["updated"]}') {
    throw new Error('latest value must replace the previous value');
  }
  if ((await cache.get('book-b')) !== undefined) {
    throw new Error('cache values must remain isolated by key');
  }
}
