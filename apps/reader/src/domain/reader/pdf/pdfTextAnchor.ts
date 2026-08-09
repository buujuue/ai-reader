/**
 * PDF 文本锚点(Anchor)的编码与恢复。
 *
 * 工单 #15:PDF 文本 Anchor 必须可序列化并包含足以恢复和验证选中文字的版本化
 * 信息。PDF 没有 CFI;本模块以「页码 + 归一化矩形」表达定位,作为 `TextAnchor.cfi`
 * 的承载值。选中文字引文、前后文与文档版本由通用的 `buildTextAnchor`(textAnchor.ts)
 * 在 `cfi` 之外以 `quote`/`before`/`after`/`documentVersion` 字段保存(ADR-0008)。
 *
 * 归一化矩形以 0..1 相对坐标表达,因此缩放、适配模式或重新渲染后仍能按同一
 * 比例映射回页面正文,保证高亮与选区对齐。
 */

/** 归一化矩形(0..1,相对页面)。 */
export interface PdfNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一条待绘制的高亮(批注或搜索命中):归一化矩形 + 颜色。 */
export interface PdfHighlight {
  rect: PdfNormalizedRect;
  color: string;
}

/** PDF 文本锚点的定位信息(解码后的结构)。 */
export interface PdfTextAnchorLocation {
  /** 1 起始页码。 */
  page: number;
  /** 归一化矩形。 */
  rect: PdfNormalizedRect;
}

/** 页面内指针点,使用视口坐标。 */
export interface PdfPointerPoint {
  x: number;
  y: number;
}

/** 锚点编码前缀(PDF 文本锚点与 EPUB CFI 区分)。 */
const PDF_ANCHOR_PREFIX = 'pdf-text:';

/**
 * 把页码与归一化矩形编码成可序列化字符串(存入 TextAnchor.cfi / 命中 cfi)。
 * 格式:`pdf-text:<page>:<x>:<y>:<w>:<h>`,矩形分量保留 5 位小数以保证往返稳定。
 */
export function encodePdfTextAnchor(location: PdfTextAnchorLocation): string {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = location.rect;
  const parts = [
    String(location.page),
    clamp(r.x).toFixed(5),
    clamp(r.y).toFixed(5),
    clamp(r.width).toFixed(5),
    clamp(r.height).toFixed(5),
  ];
  return PDF_ANCHOR_PREFIX + parts.join(':');
}

/** 解码锚点字符串;非 PDF 锚点或损坏时返回 null。 */
export function decodePdfTextAnchor(value: string): PdfTextAnchorLocation | null {
  if (!value.startsWith(PDF_ANCHOR_PREFIX)) {
    return null;
  }
  const rest = value.slice(PDF_ANCHOR_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 5) {
    return null;
  }
  const page = Number(parts[0]);
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  const w = Number(parts[3]);
  const h = Number(parts[4]);
  if (!Number.isInteger(page) || page < 1) {
    return null;
  }
  if ([x, y, w, h].some((n) => !Number.isFinite(n))) {
    return null;
  }
  return { page, rect: { x, y, width: w, height: h } };
}

/**
 * 判断某字符串是否为 PDF 文本锚点(供上层按格式分派导航/绘制)。
 */
export function isPdfTextAnchor(value: string): boolean {
  return value.startsWith(PDF_ANCHOR_PREFIX);
}

/**
 * 把 DOM Range 的显示矩形换算成页面内的归一化矩形。
 * `pageRect` 为页面元素的 getBoundingClientRect(显示坐标),`rangeRect` 为
 * Range 的 getBoundingClientRect。两者应处于同一视口坐标系。
 */
export function normalizeRectFromRangeRect(
  rangeRect: { left: number; top: number; width: number; height: number },
  pageRect: { left: number; top: number; width: number; height: number },
): PdfNormalizedRect | null {
  if (pageRect.width <= 0 || pageRect.height <= 0) {
    return null;
  }
  const x = (rangeRect.left - pageRect.left) / pageRect.width;
  const y = (rangeRect.top - pageRect.top) / pageRect.height;
  const width = rangeRect.width / pageRect.width;
  const height = rangeRect.height / pageRect.height;
  return { x, y, width, height };
}

/**
 * 把页面上的两次指针位置归一化为区域矩形。
 * 端点会先限制在页面边界内,因此支持任意方向拖拽且不会产生越界锚点。
 */
export function normalizeRectFromPoints(
  start: PdfPointerPoint,
  end: PdfPointerPoint,
  pageRect: { left: number; top: number; width: number; height: number },
): PdfNormalizedRect | null {
  if (pageRect.width <= 0 || pageRect.height <= 0) {
    return null;
  }
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const startX = clamp((start.x - pageRect.left) / pageRect.width);
  const startY = clamp((start.y - pageRect.top) / pageRect.height);
  const endX = clamp((end.x - pageRect.left) / pageRect.width);
  const endY = clamp((end.y - pageRect.top) / pageRect.height);
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  return {
    x,
    y,
    width: Math.max(startX, endX) - x,
    height: Math.max(startY, endY) - y,
  };
}
