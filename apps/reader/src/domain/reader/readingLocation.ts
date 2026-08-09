/**
 * 阅读位置(ReadingLocation):可序列化、可交给 BookDocument 恢复的视图位置。
 * 它不直接暴露具体渲染器对象(DOM Range、滚动像素等)。
 *
 * - EPUB 阅读位置由 CFI 表达。
 * - PDF 阅读位置由页码与视口状态(缩放、适配模式)表达,同时承载滚动位移,
 *   以便分页/滚动模式都能在重启后恢复页面与视口状态。
 */

/** PDF 页面适配模式。 */
export type PdfFitMode = 'width' | 'height' | 'page' | 'actual';

/** EPUB 阅读位置(CFI)。 */
export interface EpubReadingLocation {
  kind: 'epub';
  /** EPUB 规范化位置(CFI)。 */
  cfi: string;
}

/** PDF 阅读位置:页码 + 视口状态。页面与视口(缩放/适配)随阅读位置一并持久化。 */
export interface PdfReadingLocation {
  kind: 'pdf';
  /** 1 起始页码。 */
  page: number;
  /** 滚动模式下当前滚动位移(px);分页模式为 0。 */
  scrollTop: number;
  /** 缩放(百分比整数,如 100 表示 100%)。 */
  zoom: number;
  /** 页面适配模式。 */
  fit: PdfFitMode;
}

/** Markdown 阅读位置:复用 Foliate 分页器的 CFI(与 EPUB 一致)。 */
export interface MarkdownReadingLocation {
  kind: 'markdown';
  /** Markdown 章节内规范化位置(CFI)。 */
  cfi: string;
}

/** 统一的阅读位置。 */
export type ReadingLocation =
  | EpubReadingLocation
  | PdfReadingLocation
  | MarkdownReadingLocation;

export function isPdfFitMode(value: unknown): value is PdfFitMode {
  return value === 'width' || value === 'height' || value === 'page' || value === 'actual';
}

export function isReadingLocation(value: unknown): value is ReadingLocation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'epub' || candidate.kind === 'markdown') {
    return typeof candidate.cfi === 'string';
  }
  if (candidate.kind === 'pdf') {
    return (
      typeof candidate.page === 'number' &&
      typeof candidate.scrollTop === 'number' &&
      typeof candidate.zoom === 'number' &&
      isPdfFitMode(candidate.fit)
    );
  }
  return false;
}