import { describe, expect, it } from 'vitest';

import { formatFromSourceFileName, formatLabel } from './materialFormat';

describe('formatFromSourceFileName', () => {
  it('识别 EPUB 扩展名(不区分大小写)', () => {
    expect(formatFromSourceFileName('book.epub')).toBe('epub');
    expect(formatFromSourceFileName('BOOK.EPUB')).toBe('epub');
  });

  it('识别 PDF 扩展名', () => {
    expect(formatFromSourceFileName('paper.pdf')).toBe('pdf');
  });

  it('识别 Markdown 常见扩展名', () => {
    expect(formatFromSourceFileName('notes.md')).toBe('markdown');
    expect(formatFromSourceFileName('notes.markdown')).toBe('markdown');
    expect(formatFromSourceFileName('notes.mkd')).toBe('markdown');
  });

  it('无扩展名或未知扩展名归为 unknown', () => {
    expect(formatFromSourceFileName('no-extension')).toBe('unknown');
    expect(formatFromSourceFileName('book.txt')).toBe('unknown');
    expect(formatFromSourceFileName('')).toBe('unknown');
  });

  it('只取最后一个点后的扩展名', () => {
    expect(formatFromSourceFileName('dir.with.dots/book.epub')).toBe('epub');
  });
});

describe('formatLabel', () => {
  it('返回简体中文展示标签', () => {
    expect(formatLabel('epub')).toBe('EPUB');
    expect(formatLabel('pdf')).toBe('PDF');
    expect(formatLabel('markdown')).toBe('Markdown');
    expect(formatLabel('unknown')).toBe('未知格式');
  });
});