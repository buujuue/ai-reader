import { describe, expect, it } from 'vitest';

import { inspectMarkdown, MarkdownInspectError, readableNameFromFileName } from './markdownInspector';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readableNameFromFileName', () => {
  it('去掉扩展名并转换分隔符', () => {
    expect(readableNameFromFileName('我的笔记.md')).toBe('我的笔记');
    expect(readableNameFromFileName('chapter-01_notes.MARKDOWN')).toBe('chapter 01 notes');
  });

  it('空结果时回退到原文件名', () => {
    expect(readableNameFromFileName('.md')).toBe('.md');
  });
});

describe('inspectMarkdown', () => {
  it('提取标题(frontmatter 优先)与作者', async () => {
    const result = await inspectMarkdown(
      enc('---\ntitle: 我的笔记\nauthor: 用户\n---\n# 正文'),
      'notes.md',
    );
    expect(result.metadata.title).toBe('我的笔记');
    expect(result.metadata.author).toBe('用户');
    expect(result.metadata.language).toBeNull();
  });

  it('无元数据时用首个一级标题', async () => {
    const result = await inspectMarkdown(enc('# 一级标题\n\n正文'), 'notes.md');
    expect(result.metadata.title).toBe('一级标题');
  });

  it('无标题时用可读的文件名兜底', async () => {
    const result = await inspectMarkdown(enc('只有一段正文'), 'my-notes.md');
    expect(result.metadata.title).toBe('my notes');
  });

  it('空字节抛 empty 错误', async () => {
    const error = await inspectMarkdown(new Uint8Array(0), 'a.md').catch((error) => error);
    expect(error).toBeInstanceOf(MarkdownInspectError);
    expect(error.kind).toBe('empty');
  });

  it('纯空白内容视为 empty', async () => {
    const error = await inspectMarkdown(enc('   \n\t '), 'a.md').catch((error) => error);
    expect(error.kind).toBe('empty');
  });
});