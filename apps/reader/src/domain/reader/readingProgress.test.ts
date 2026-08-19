import { describe, expect, it } from 'vitest';

import {
  formatReadingProgress,
  normalizeReadingProgress,
} from './readingProgress';

describe('ReadingProgress', () => {
  it('只保留可序列化的位置反馈字段', () => {
    expect(
      normalizeReadingProgress({
        fraction: 0.246,
        section: { current: 1, total: 4 },
        location: { current: 12, next: 13, total: 80 },
        tocItem: { label: '第二章', href: 'chapter2.xhtml' },
        pageItem: { label: '第 13 页', href: 'chapter2.xhtml#p13' },
        range: new Range(),
      }),
    ).toEqual({
      fraction: 0.246,
      section: { current: 1, total: 4 },
      location: { current: 12, next: 13, total: 80 },
      tocLabel: '第二章',
      pageLabel: '第 13 页',
    });
  });

  it('没有有效进度时返回 null,不把坏数据显示成 0%', () => {
    expect(normalizeReadingProgress({ fraction: Number.NaN })).toBeNull();
    expect(formatReadingProgress(null)).toBe('位置待定');
  });

  it('格式化总进度并优先展示目录标题', () => {
    const progress = normalizeReadingProgress({
      fraction: 0.5,
      section: { current: 0, total: 2 },
      tocItem: { label: '第一章' },
    });
    expect(formatReadingProgress(progress)).toBe('50% · 第一章');
  });
});
