/**
 * PDF 文本层定位。
 *
 * 工单 #15:让带文字层的 PDF 获得与其他阅读材料一致的文本选择与高亮能力。
 * 本模块把 PDF.js 文本内容项(带 `transform` 仿射矩阵与片段尺寸)换算成与
 * Canvas 正文对齐的绝对定位 span,使文本可选择、可复制,并让高亮覆盖层能
 * 贴合正文(ADR-0010:文本层仍是纯 DOM,不执行任何脚本)。
 *
 * 定位算法参考 pdf.js `TextLayer`(Apache-2.0,见 docs/legal/third-party.md):
 * 每个文本项的 `transform` 把文本空间映射到 PDF 用户空间;再叠加页面的显示
 * 缩放,得到 CSS 像素坐标。PDF 用户空间 y 轴向上,故 `top` 需翻转。
 */

/**
 * 文本项的显示布局(px,相对所属页面元素)。
 * width/height 为显示尺寸,供高亮矩形与选区换算使用。
 */
export interface PositionedTextSpan {
  /** 与文本项一一对应的 <span> 元素。 */
  element: HTMLSpanElement;
  /** 文本内容。 */
  str: string;
  /** 显示的左上角与尺寸(CSS px,相对页面元素)。 */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 文本项几何数据(从 PdfTextItem 归纳而来)。 */
export interface PdfTextGeometry {
  str: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

/** 页面基线尺寸(scale =1 时的用户空间尺寸),用于 y 翻转与归一化。 */
export interface PdfTextPageDims {
  width: number;
  height: number;
}

/** 文本层构建入参。 */
export interface BuildPdfTextLayerOptions {
  /** 页面元素(文本层挂载点)。 */
  pageElement: HTMLElement;
  /** 文本内容项。 */
  items: PdfTextGeometry[];
  /** 页面基线尺寸(scale=1)。 */
  pageDims: PdfTextPageDims;
  /** 显示缩放(显示宽度 / 基线宽度)。 */
  scale: number;
}

/** 文本行基线到行顶的比例(ascent),用于把基线换算成 span 的 top。 */
const ASCENT_RATIO = 0.8;

/**
 * 把单个文本项的 transform 换算成显示布局。
 * 参考 pdf.js:`transform` 为 [a,b,c,d,e,f],其中 (e,f) 是基线原点,
 * 垂直缩放分量用来推算字号。y 从 PDF 用户空间向上翻转为 CSS 向下。
 */
export function layoutTextSpan(
  item: PdfTextGeometry,
  pageDims: PdfTextPageDims,
  scale: number,
): { left: number; top: number; width: number; height: number } {
  const t = item.transform ?? [1, 0, 0, 1, 0, 0];
  // 垂直缩放分量:字号高度(用户空间)。
  const fontHeight = Math.hypot(t[2] as number, t[3] as number);
  const ascent = fontHeight * ASCENT_RATIO;
  // 基线原点(e,f)缩放后,再翻转 y。
  const left = (t[4] as number) * scale;
  const baselineFromBottom = (t[5] as number) * scale;
  const top = pageDims.height * scale - baselineFromBottom - ascent * scale;
  const width = (item.width ?? 0) * scale;
  const height = fontHeight * scale;
  return { left, top, width, height };
}

/**
 * 在页面元素内构建与 Canvas 对齐的文本层 spans。返回每个 span 的显示几何,
 * 供选区→锚点换算与命中高亮使用。返回空数组表示该页无文字层(扫描页)。
 */
export function buildPdfTextLayer(options: BuildPdfTextLayerOptions): PositionedTextSpan[] {
  const { pageElement, items, pageDims, scale } = options;
  const results: PositionedTextSpan[] = [];

  for (const item of items) {
    if (!item.str) {
      continue;
    }
    const layout = layoutTextSpan(item, pageDims, scale);
    const span = document.createElement('span');
    span.className = 'pdf-text-span';
    span.textContent = item.str;
    span.style.position = 'absolute';
    span.style.left = `${layout.left.toFixed(2)}px`;
    span.style.top = `${layout.top.toFixed(2)}px`;
    span.style.fontSize = `${layout.height.toFixed(2)}px`;
    span.style.lineHeight = '1';
    span.style.whiteSpace = 'pre';
    span.style.transformOrigin = '0 0';
    pageElement.appendChild(span);
    results.push({ element: span, str: item.str, ...layout });
  }

  return results;
}