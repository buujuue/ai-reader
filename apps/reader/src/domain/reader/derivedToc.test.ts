import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DERIVED_TOC_BUDGET,
  EPUB_DERIVED_TOC_ALGORITHM_VERSION,
  buildDerivedToc,
  buildDerivedTocCacheKey,
  createEpubDerivedTocCache,
  deriveEpubToc,
} from './derivedToc';
import { assertEpubDerivedTocCacheContract } from './derivedTocCacheContract';

describe('EPUB 缺失目录时的本地推导导航', () => {
  it('从章节标题生成稳定目标、层级和推导标记', () => {
    const toc = buildDerivedToc([
      {
        href: 'text/chapter-1.xhtml',
        text: `<html><body>
          <h1 id="intro">引言</h1>
          <h2 id="scope">范围</h2>
          <h3>没有稳定锚点的小节</h3>
          <h1 id="chapter-2">第二章</h1>
        </body></html>`,
      },
    ]);

    expect(toc).toEqual([
      {
        label: '引言',
        href: 'text/chapter-1.xhtml#intro',
        source: 'derived',
        subitems: [
          {
            label: '范围',
            href: 'text/chapter-1.xhtml#scope',
            source: 'derived',
            subitems: [
              {
                label: '没有稳定锚点的小节',
                href: 'text/chapter-1.xhtml',
                source: 'derived',
                subitems: null,
              },
            ],
          },
        ],
      },
      {
        label: '第二章',
        href: 'text/chapter-1.xhtml#chapter-2',
        source: 'derived',
        subitems: null,
      },
    ]);
  });

  it('忽略空标题和目录/页脚中的装饰标题，没有可靠标题时返回空目录', () => {
    expect(
      buildDerivedToc([
        {
          href: 'chapter.xhtml',
          text: `<html><body>
            <nav><h1>原生目录残片</h1></nav>
            <footer><h2>页脚</h2></footer>
            <h1>   </h1>
          </body></html>`,
        },
      ]),
    ).toEqual([]);
  });

  it('按章节、文本和节点预算停止扫描，异常章节不会阻塞正文', async () => {
    const loaders = Array.from({ length: 4 }, (_, index) => vi.fn(async () =>
      `<html><body><h1 id="h${index}">第${index}章</h1></body></html>`,
    ));
    loaders[1]!.mockRejectedValueOnce(new Error('章节损坏'));

    const toc = await deriveEpubToc(
      loaders.map((loadText, index) => ({ href: `chapter-${index}.xhtml`, loadText })),
      {
        sourceFingerprint: 'book-hash-1',
        budget: {
          maxSections: 3,
          maxTotalTextCharacters: 200,
        },
      },
    );

    expect(toc.map((item) => item.label)).toEqual(['第0章', '第2章']);
    expect(loaders[3]).not.toHaveBeenCalled();
    expect(DEFAULT_DERIVED_TOC_BUDGET.maxDepth).toBe(6);
  });

  it('缓存按书籍指纹和算法版本隔离，缓存损坏时重建', async () => {
    const cache = createEpubDerivedTocCache();
    const firstLoader = vi.fn(async () => '<h1 id="cached">缓存标题</h1>');
    const options = {
      sourceFingerprint: 'book-hash-2',
      cache,
    };

    await expect(
      deriveEpubToc([{ href: 'chapter.xhtml', loadText: firstLoader }], options),
    ).resolves.toEqual([
      {
        label: '缓存标题',
        href: 'chapter.xhtml#cached',
        source: 'derived',
        subitems: null,
      },
    ]);

    const secondLoader = vi.fn(async () => {
      throw new Error('不应再次读取章节');
    });
    await expect(
      deriveEpubToc([{ href: 'chapter.xhtml', loadText: secondLoader }], options),
    ).resolves.toHaveLength(1);
    expect(secondLoader).not.toHaveBeenCalled();

    const key = buildDerivedTocCacheKey('book-hash-2');
    expect(key).toContain(EPUB_DERIVED_TOC_ALGORITHM_VERSION);
    await cache.set(key, '{corrupt');

    const rebuildLoader = vi.fn(async () => '<h1 id="rebuilt">重建标题</h1>');
    await expect(
      deriveEpubToc([{ href: 'chapter.xhtml', loadText: rebuildLoader }], options),
    ).resolves.toEqual([
      {
        label: '重建标题',
        href: 'chapter.xhtml#rebuilt',
        source: 'derived',
        subitems: null,
      },
    ]);
    expect(rebuildLoader).toHaveBeenCalledOnce();
  });

  it('内存缓存满足推导目录缓存契约', async () => {
    await assertEpubDerivedTocCacheContract(createEpubDerivedTocCache);
  });
});
