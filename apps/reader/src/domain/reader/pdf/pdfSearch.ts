/**
 * PDF 文本搜索。
 *
 * 工单 #15:让带文字层的 PDF 支持当前材料搜索。搜索按页增量读取文本内容,
 * 用普通文本匹配查找命中,产出进度与命中(命中携带页码 + 归一化矩形的
 * PDF 锚点),可取消(生成器 `return()` 即停止)。不做全书库索引,也不把
 * 缺文字层的扫描页误报为命中。
 */

import type { SearchEvent, SearchMatch, SearchOptions } from '../search';
import type { PdfDocumentProxy, PdfPage } from './pdfLibrary';
import { encodePdfTextAnchor, type PdfNormalizedRect } from './pdfTextAnchor';

/** 命中摘录上下文长度(字符)。 */
const CONTEXT_LENGTH = 50;

/** 页面文本项:文本 + 其在 PDF 用户空间的几何(用于计算命中矩形)。 */
interface PageTextItem {
  str: string;
  /** 基线原点 x(PDF 用户空间)。 */
  x: number;
  /** 基线原点 y(PDF 用户空间)。 */
  y: number;
  /** 文本宽度(PDF 用户空间)。 */
  width: number;
  /** 文本高度(字号,PDF 用户空间)。 */
  height: number;
}

/** 从一页的文本内容项归纳出文本与几何。扫描页无文字层时返回空数组。 */
function collectPageText(page: PdfPage): Promise<PageTextItem[]> {
  return page.getTextContent().then((content) =>
    content.items
      .filter((item) => item.str)
      .map((item) => {
        const t = item.transform ?? [1, 0, 0, 1, 0, 0];
        return {
          str: item.str,
          x: t[4] ?? 0,
          y: t[5] ?? 0,
          width: item.width ?? 0,
          height: Math.hypot(t[2] ?? 0, t[3] ?? 0) || (item.height ?? 0),
        };
      }),
  );
}

/** 生成页面文本的拼接串及各文本项的累积偏移。 */
function joinPageText(items: PageTextItem[]): { text: string; cum: number[] } {
  const cum: number[] = [0];
  let text = '';
  for (const item of items) {
    text += item.str;
    cum.push(text.length);
  }
  return { text, cum };
}

/** 把扁平字符偏移映射回 (文本项下标, 项内偏移)。 */
function nodeAt(cum: number[], offset: number): { index: number; offset: number } {
  let lo = 0;
  let hi = cum.length - 2;
  if (hi < 0) return { index: 0, offset: 0 };
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { index: lo, offset: offset - cum[lo]! };
}

/** 计算覆盖 [start,end) 字符区间的项子集矩形(归一化 0..1)。 */
function rectForRange(
  items: PageTextItem[],
  cum: number[],
  pageWidth: number,
  pageHeight: number,
  startOffset: number,
  endOffset: number,
): PdfNormalizedRect | null {
  if (items.length === 0 || pageWidth <= 0 || pageHeight <= 0) {
    return null;
  }
  const start = nodeAt(cum, startOffset);
  const end = nodeAt(cum, endOffset);
  let left = items[start.index]!.x;
  let right = items[end.index]!.x + items[end.index]!.width;
  let top = items[start.index]!.y;
  let bottom = items[start.index]!.y + items[start.index]!.height;
  for (let i = start.index; i <= end.index; i += 1) {
    const item = items[i]!;
    left = Math.min(left, item.x);
    right = Math.max(right, item.x + item.width);
    top = Math.min(top, item.y);
    bottom = Math.max(bottom, item.y + item.height);
  }
  // PDF 用户空间 y 向上:归一化时翻转 y。
  const x = left / pageWidth;
  const y = 1 - bottom / pageHeight;
  const width = (right - left) / pageWidth;
  const height = (bottom - top) / pageHeight;
  return { x, y, width, height };
}

/** 生成一段文本的摘录(pre/match/post)。 */
function makeExcerpt(text: string, index: number, matchLen: number): { pre: string; match: string; post: string } {
  // 在原文上取上下文更能反映真实内容。
  const start = Math.max(0, index - CONTEXT_LENGTH);
  const end = Math.min(text.length, index + matchLen + CONTEXT_LENGTH);
  const pre = text.slice(start, index).trimStart();
  const post = text.slice(index + matchLen, end).trimEnd();
  return {
    pre: pre.slice(-CONTEXT_LENGTH),
    match: text.slice(index, index + matchLen),
    post: post.slice(0, CONTEXT_LENGTH),
  };
}

/** 在单个页面文本中查找所有命中(flat 偏移),返回 [start, len] 列表。 */
function findMatches(text: string, query: string, matchCase: boolean): Array<[number, number]> {
  if (!query) return [];
  const haystack = matchCase ? text : text.toLocaleLowerCase();
  const needle = matchCase ? query : query.toLocaleLowerCase();
  const results: Array<[number, number]> = [];
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    results.push([index, needle.length]);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return results;
}

/** 搜索一页,产出该页的命中事件。 */
async function* searchPage(
  pageNumber: number,
  page: PdfPage,
  options: Required<Pick<SearchOptions, 'query'>> & { matchCase: boolean },
): AsyncGenerator<SearchEvent, void, void> {
  const items = await collectPageText(page);
  if (items.length === 0) {
    // 扫描页无文字层:不产出命中,避免把「无文本」误报为搜索无结果。
    return;
  }
  const { text, cum } = joinPageText(items);
  const matches = findMatches(text, options.query, options.matchCase);
  if (matches.length === 0) {
    return;
  }
  const viewport = page.getViewport({ scale: 1 });
  for (const [start, len] of matches) {
    const rect = rectForRange(items, cum, viewport.width, viewport.height, start, start + len);
    const cfi = encodePdfTextAnchor({ page: pageNumber, rect: rect ?? { x: 0, y: 0, width: 0, height: 0 } });
    const match: SearchMatch = { cfi, excerpt: makeExcerpt(text, start, len) };
    yield { kind: 'match', match };
  }
}

/**
 * 在 PDF 各页中增量搜索。逐页读取文本内容并产出进度与命中;调用方可通过
 * 生成器 `return()` 取消(搜索到一半即停止)。全文对扫描页不误报命中。
 */
export async function* searchPdf(
  pdf: PdfDocumentProxy,
  options: SearchOptions,
): AsyncGenerator<SearchEvent, void, void> {
  const pageCount = pdf.numPages;
  const query = options.query.trim();
  if (!query) {
    return;
  }
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    yield { kind: 'progress', progress: pageNumber / pageCount };
    yield* searchPage(pageNumber, page, { query, matchCase: options.matchCase ?? false });
  }
  yield { kind: 'progress', progress: 1 };
}