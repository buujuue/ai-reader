import { describe, expect, it } from 'vitest';

import {
  EPUB_CANONICAL_TRANSFORM_VERSION,
  EPUB_DISPLAY_ONLY_ATTRIBUTE,
  buildEpubDerivedCacheKey,
  createEpubCanonicalTransform,
  createEpubDerivedCache,
  removeEpubDisplayOnlyNodes,
} from './epubCanonical';

describe('EPUB 规范转换', () => {
  it('清洗阅读资源但不改写传入的原始文本', () => {
    const transform = createEpubCanonicalTransform({ sourceFingerprint: 'fingerprint-1' });
    const source = '<html><body><script>alert(1)</script><p>正文</p></body></html>';

    const transformed = transform.transform('application/xhtml+xml', source);

    expect(transformed).not.toContain('<script');
    expect(transformed).toContain('正文');
    expect(source).toBe('<html><body><script>alert(1)</script><p>正文</p></body></html>');
  });

  it('把规范转换版本纳入派生缓存键', () => {
    const input = {
      sourceFingerprint: 'fingerprint-1',
      resourceType: 'application/xhtml+xml',
      resourceText: '<p>正文</p>',
    };

    const current = buildEpubDerivedCacheKey(input);
    const upgraded = buildEpubDerivedCacheKey({
      ...input,
      transformVersion: 'epub-canonical-v2',
    });

    expect(current).toContain(EPUB_CANONICAL_TRANSFORM_VERSION);
    expect(upgraded).not.toBe(current);
  });

  it('规范转换版本升级后不会命中旧派生缓存', () => {
    const cache = createEpubDerivedCache();
    const source = '<html><body><script>alert(1)</script><p>正文</p></body></html>';
    const v1 = createEpubCanonicalTransform({
      sourceFingerprint: 'fingerprint-1',
      cache,
      transformVersion: 'epub-canonical-v1',
    });
    const v2 = createEpubCanonicalTransform({
      sourceFingerprint: 'fingerprint-1',
      cache,
      transformVersion: 'epub-canonical-v2',
    });

    const first = v1.transform('application/xhtml+xml', source);
    const second = v2.transform('application/xhtml+xml', source);

    expect(first).toBe(second);
    expect(cache.get(v1.cacheKey('application/xhtml+xml', source))).toBe(first);
    expect(cache.get(v2.cacheKey('application/xhtml+xml', source))).toBe(second);
    expect(v1.cacheKey('application/xhtml+xml', source)).not.toBe(
      v2.cacheKey('application/xhtml+xml', source),
    );
  });

  it('移除展示辅助节点,避免其文字进入 CFI 与搜索所见正文', () => {
    const doc = document.implementation.createHTMLDocument('epub');
    doc.body.innerHTML = `<p>正文<span ${EPUB_DISPLAY_ONLY_ATTRIBUTE}>辅助词</span></p>`;

    removeEpubDisplayOnlyNodes(doc);

    expect(doc.body.textContent).toBe('正文');
  });
});
