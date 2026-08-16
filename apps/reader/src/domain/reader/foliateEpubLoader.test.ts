import { describe, expect, it } from 'vitest';

import { buildEpub } from '../library/epub/zipWriter';
import { createFoliateEpubLoader } from './foliateEpubLoader';
import { NATIVE_EPUB_REQUIRED_CAPABILITIES } from './nativeEpub';

function asFile(bytes: Uint8Array): File {
  return new File([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], 'book.epub', {
    type: 'application/epub+zip',
  });
}

describe('foliate EPUB loader 原生预取边界', () => {
  it('有预取时只覆盖声明的文本入口,章节与资源仍从 JS ZIP loader 读取', async () => {
    const bytes = buildEpub({
      title: '预取测试',
      author: '作者',
      language: 'zh',
      withCover: true,
      withImage: true,
    });
    const loader = await createFoliateEpubLoader(asFile(bytes), {
      parity: {
        protocolVersion: 1,
        semanticSource: 'foliate-js',
        platform: 'windows',
        validated: true,
        capabilities: [...NATIVE_EPUB_REQUIRED_CAPABILITIES],
      },
      textCache: new Map([['META-INF/container.xml', '<container>native</container>']]),
      sizes: new Map([['OEBPS/chapter1.xhtml', 321]]),
    });

    await expect(loader.loadText('META-INF/container.xml')).resolves.toBe(
      '<container>native</container>',
    );
    await expect(loader.loadText('OEBPS/chapter1.xhtml')).resolves.toContain('这是第一章');
    await expect(loader.loadBlob('OEBPS/images/cover.png')).resolves.toBeInstanceOf(Blob);
    expect(loader.getSize('OEBPS/chapter1.xhtml')).toBe(321);
  });

  it('没有预取时完全使用同一份 JavaScript ZIP loader', async () => {
    const bytes = buildEpub({ title: '纯 JS', language: 'zh' });
    const loader = await createFoliateEpubLoader(asFile(bytes));

    await expect(loader.loadText('META-INF/container.xml')).resolves.toContain('rootfile');
    expect(loader.getSize('OEBPS/chapter1.xhtml')).toBeGreaterThan(0);
  });

  it('预取尺寸优先覆盖同一 ZIP 条目的 JavaScript 尺寸', async () => {
    const bytes = buildEpub({ title: '编码路径', language: 'zh' });
    const loader = await createFoliateEpubLoader(asFile(bytes), {
      parity: {
        protocolVersion: 1,
        semanticSource: 'foliate-js',
        platform: 'windows',
        validated: true,
        capabilities: [...NATIVE_EPUB_REQUIRED_CAPABILITIES],
      },
      textCache: new Map(),
      sizes: new Map([['OEBPS/chapter1.xhtml', 456]]),
    });

    expect(loader.getSize('OEBPS/chapter1.xhtml')).toBe(456);
  });
});
