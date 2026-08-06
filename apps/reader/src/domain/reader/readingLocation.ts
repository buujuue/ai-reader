/**
 * 阅读位置(ReadingLocation):可序列化、可交给 BookDocument 恢复的视图位置。
 * 它不直接暴露具体渲染器对象(DOM Range、滚动像素等)。
 *
 * 第一版 EPUB 阅读位置由 CFI 表达;后续 PDF/Markdown 会增加各自的 kind。
 */
export interface ReadingLocation {
  kind: 'epub';
  /** EPUB 规范化位置(CFI)。 */
  cfi: string;
}

export function isReadingLocation(value: unknown): value is ReadingLocation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ReadingLocation>;
  return candidate.kind === 'epub' && typeof candidate.cfi === 'string';
}