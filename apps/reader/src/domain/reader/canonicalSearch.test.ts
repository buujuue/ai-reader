import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_SEARCH_QUERY_CONFIG_VERSION,
  MAX_REGEX_RESULTS,
  REGEX_SECTION_TIMEOUT_MS,
  buildCanonicalSearchIndexKey,
  createCanonicalSectionText,
  findCanonicalSectionMatches,
  findRegexMatchOffsetsInWorker,
  isUsableCanonicalSearchIndex,
  SearchBudgetError,
} from './canonicalSearch';

function section(markup: string) {
  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  return createCanonicalSectionText(doc);
}

describe('规范可读文本搜索', () => {
  it('跨内联标签搜索，并排除脚本、展示辅助与 CFI 忽略节点但保留脚注', () => {
    const content = section(
      '<p>正<strong>文</strong><span data-ai-reader-display-only>辅助</span>' +
        '<span data-cfi-inert>词典</span><script>正文</script></p>' +
        '<aside epub:type="footnote">脚注正文</aside>',
    );

    expect(content.text).toBe('正文脚注正文');
    const matches = [...findCanonicalSectionMatches(content, { query: '正文' })];

    expect(matches.map((match) => match.excerpt.match)).toEqual(['正文', '正文']);
    expect(matches[0]?.start).toBe(0);
    expect(matches[0]?.end).toBe(2);
    expect(matches[0]?.range).toBeInstanceOf(Range);
  });

  it('正则匹配跨文本节点，零宽命中不会死循环', () => {
    const content = section('<p>你好<strong>世界</strong>！</p>');

    const matches = [
      ...findCanonicalSectionMatches(content, { query: '好.界', mode: 'regex' }),
    ];
    expect(matches.map((match) => match.excerpt.match)).toEqual(['好世界']);
    expect([...findCanonicalSectionMatches(section('abc'), { query: 'x*', mode: 'regex' })]).toEqual([]);
  });

  it('无效、危险或过长正则表达式返回带 code 的明确错误', () => {
    for (const query of ['(', '^(a+)+$', '^(a|aa)+$', 'x'.repeat(257)]) {
      expect(() => [...findCanonicalSectionMatches(section('abc'), { query, mode: 'regex' })]).toThrow(
        SearchBudgetError,
      );
    }

    expect([...findCanonicalSectionMatches(section('正文'), { query: '正文+', mode: 'regex' })]).toHaveLength(1);

    try {
      [...findCanonicalSectionMatches(section('abc'), { query: '(', mode: 'regex' })];
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_REGEX' });
    }
  });

  it('按单章节时间预算和全局最大结果数停止正则搜索', () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValue(REGEX_SECTION_TIMEOUT_MS + 1);
    expect(() => [
      ...findCanonicalSectionMatches(
        section('abc'),
        { query: 'a', mode: 'regex' },
        { resultCount: 0 },
        { now },
      ),
    ]).toThrow(SearchBudgetError);

    const many = section(Array.from({ length: MAX_REGEX_RESULTS + 1 }, () => 'x').join(' '));
    try {
      [...findCanonicalSectionMatches(many, { query: 'x', mode: 'regex' })];
      throw new Error('应达到正则结果上限');
    } catch (error) {
      expect(error).toMatchObject({ code: 'REGEX_RESULT_LIMIT' });
    }
  });

  it('取消的正则查询返回明确的取消错误', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      findRegexMatchOffsetsInWorker('正文', '正文', false, controller.signal),
    ).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
  });

  it('索引键包含书籍指纹、规范转换版本和查询配置版本', () => {
    const current = buildCanonicalSearchIndexKey({
      sourceFingerprint: 'book-a',
      canonicalTransformVersion: 'epub-canonical-v1',
    });
    const changedBook = buildCanonicalSearchIndexKey({
      sourceFingerprint: 'book-b',
      canonicalTransformVersion: 'epub-canonical-v1',
    });
    const changedTransform = buildCanonicalSearchIndexKey({
      sourceFingerprint: 'book-a',
      canonicalTransformVersion: 'epub-canonical-v2',
    });

    expect(current).toContain(CANONICAL_SEARCH_QUERY_CONFIG_VERSION);
    expect(current).not.toBe(changedBook);
    expect(current).not.toBe(changedTransform);
  });

  it('损坏索引快照不会被当作可用结果', () => {
    expect(
      isUsableCanonicalSearchIndex(
        {
          key: 'key',
          sections: {
            '0': { textNodes: ['正文'], characterCount: 99 },
          },
          totalCharacters: 99,
        },
        'key',
      ),
    ).toBe(false);
  });
});
