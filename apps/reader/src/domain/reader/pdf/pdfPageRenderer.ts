import type { PdfPage, PdfRenderTask, PdfViewport } from './pdfLibrary';
import { buildPdfTextLayer, type PositionedTextSpan } from './pdfTextLayer';
import {
  normalizeRectFromPoints,
  type PdfHighlight,
  type PdfPointerPoint,
} from './pdfTextAnchor';
import type { AreaSelection } from '../bookDocument';

/** 页面光栅化函数:把某一页以给定缩放绘制到 canvas。生产用 PDF.js page.render,
 *  测试注入伪实现以在无真实 canvas 2d 环境下验证协调逻辑。返回渲染任务(可取消)。 */
export type PdfPageRasterizer = (
  page: PdfPage,
  canvas: HTMLCanvasElement,
  scale: number,
) => PdfRenderTask;

export interface PdfPageRendererCallbacks {
  onAreaSelection?: ((selection: AreaSelection) => void) | undefined;
  /** 页面读取/渲染失败时保留错误上下文,由上层命令展示。 */
  onError?: ((error: unknown) => void) | undefined;
}

/** 设备像素比上限:过度采样会按 DPR 平方放大内存,这里夹到 2 以控制画布预算
 *  (参考 Readest `pdf.js` 的 MAX_RENDER_DPR)。 */
const MAX_RENDER_DPR = 2;

/** 单一页面位图面积硬上限(像素),防止超大页面突破内存预算。 */
const MAX_CANVAS_PIXELS = 2048 * 1536;

/** 计算某一页的分级渲染 DPR:真实 DPR 被 MAX_RENDER_DPR 与单页位图预算双向夹紧,不低于 1。 */
export function computeRenderDpr(page: PdfPage, scale: number, devicePixelRatio = 1): number {
  let dpr = Math.min(devicePixelRatio || 1, MAX_RENDER_DPR);
  const { width, height } = page.getViewport({ scale });
  const area = width * height * dpr * dpr;
  if (area > MAX_CANVAS_PIXELS) {
    dpr *= Math.sqrt(MAX_CANVAS_PIXELS / area);
  }
  return Math.max(1, dpr);
}

/**
 * 单个 PDF 页面的渲染器:管理页面 wrapper、Canvas 位图与文本层,
 * 负责过期渲染取消与替换/卸载时的位图释放。
 *
 * 内存预算:渲染前把旧位图置 0;替换页面前释放旧 canvas;卸载时取消在途任务
 * 并把位图宽度/高度清零,交由垃圾回收回收 GPU 位图。
 */
export class PdfPageRenderer {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly textLayer: HTMLElement;
  private readonly highlightLayer: HTMLElement;
  private readonly areaSelectionLayer: HTMLElement;
  private readonly scanNotice: HTMLElement;

  private page: PdfPage | null = null;
  private displayScale = 1;
  private pageBaseDims = { width: 0, height: 0 };
  private renderTask: PdfRenderTask | null = null;
  private generation = 0;
  private disposed = false;
  private areaStart: PdfPointerPoint | null = null;
  private areaPointerId: number | null = null;
  /** 本页待绘制的高亮矩形(归一化)。重渲染后据此重绘覆盖层。 */
  private pendingHighlights: PdfHighlight[] = [];

  constructor(
    pageNumber: number,
    private readonly rasterize: PdfPageRasterizer,
    private readonly callbacks: PdfPageRendererCallbacks = {},
  ) {
    this.element = document.createElement('div');
    this.element.className = 'pdf-page';
    this.element.dataset.page = String(pageNumber);
    this.element.style.position = 'relative';

    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.element.appendChild(this.canvas);

    this.textLayer = document.createElement('div');
    this.textLayer.className = 'pdf-text-layer';
    this.element.appendChild(this.textLayer);

    this.highlightLayer = document.createElement('div');
    this.highlightLayer.className = 'pdf-highlight-layer';
    this.highlightLayer.style.position = 'absolute';
    this.highlightLayer.style.top = '0';
    this.highlightLayer.style.left = '0';
    this.highlightLayer.style.width = '100%';
    this.highlightLayer.style.height = '100%';
    this.highlightLayer.style.pointerEvents = 'none';
    this.element.appendChild(this.highlightLayer);

    this.areaSelectionLayer = document.createElement('div');
    this.areaSelectionLayer.className = 'pdf-area-selection-layer';
    this.areaSelectionLayer.style.position = 'absolute';
    this.areaSelectionLayer.style.top = '0';
    this.areaSelectionLayer.style.left = '0';
    this.areaSelectionLayer.style.width = '100%';
    this.areaSelectionLayer.style.height = '100%';
    this.areaSelectionLayer.style.pointerEvents = 'none';
    this.areaSelectionLayer.style.zIndex = '3';
    this.element.appendChild(this.areaSelectionLayer);

    this.scanNotice = document.createElement('div');
    this.scanNotice.className = 'pdf-scan-notice';
    this.scanNotice.setAttribute('role', 'status');
    this.scanNotice.textContent = '此页没有可选择文本，可拖动框选区域创建批注';
    this.scanNotice.style.position = 'absolute';
    this.scanNotice.style.top = '8px';
    this.scanNotice.style.right = '8px';
    this.scanNotice.style.pointerEvents = 'none';
    this.scanNotice.style.zIndex = '4';
    this.element.dataset.textSelectable = 'pending';
    this.element.appendChild(this.scanNotice);

    this.element.addEventListener('pointerdown', this.handlePointerDown);
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerup', this.handlePointerUp);
    this.element.addEventListener('pointercancel', this.handlePointerCancel);
  }

  /**
   * 渲染给定页面到当前显示缩放。若已有在途渲染(如缩放调整触发的重渲染),
   * 取消旧任务再启动新任务,杜绝过期渲染写回被替换的页面。
   */
  async render(page: PdfPage, viewport: PdfViewport, devicePixelRatio = 1): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.page = page;
    const base = page.getViewport({ scale: 1 });
    this.pageBaseDims = { width: base.width, height: base.height };
    this.displayScale = viewport.width / (base.width || 1);

    const generation = ++this.generation;
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }

    // 释放旧位图后再分配新位图,避免缩放频繁时内存峰值。
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.textLayer.replaceChildren();

    const renderDpr = computeRenderDpr(page, this.displayScale, devicePixelRatio);
    const renderScale = this.displayScale * renderDpr;
    const renderViewport = page.getViewport({ scale: renderScale });

    // CSS 盒子固定在显示尺寸,位图按 DPR 过采样后由浏览器缩放到盒子内。
    this.canvas.style.width = `${viewport.width}px`;
    this.canvas.style.height = `${viewport.height}px`;
    this.canvas.width = Math.floor(renderViewport.width);
    this.canvas.height = Math.floor(renderViewport.height);

    const canvasContext = this.canvas.getContext('2d');
    if (!canvasContext) {
      // 无 2d 上下文(极端环境):直接清空位图,不阻塞阅读流程。
      this.canvas.width = 0;
      this.canvas.height = 0;
      return;
    }

    if (renderScale === 0) {
      return;
    }

    const task = this.rasterize(page, this.canvas, renderScale);
    this.renderTask = task;
    try {
      await task.promise;
    } catch (error) {
      // 过期/卸载渲染的取消不应打断阅读;当前页面的真实失败必须向上层传播。
      this.canvas.width = 0;
      this.canvas.height = 0;
      if (!this.disposed && this.generation === generation) {
        this.callbacks.onError?.(error);
        throw error;
      }
      return;
    } finally {
      if (this.renderTask === task) {
        this.renderTask = null;
      }
    }

    // 渲染期间页面被卸载或新一代渲染已启动,丢弃过期结果并释放位图。
    if (this.disposed || this.generation !== generation) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      return;
    }

    // 文本层:扫描页无文字层时 streamTextContent 返回空,仍正常显示页面图像。
    this.textLayer.replaceChildren();
    this.textLayer.style.position = 'absolute';
    this.textLayer.style.top = '0';
    this.textLayer.style.left = '0';
    this.textLayer.style.width = `${viewport.width}px`;
    this.textLayer.style.height = `${viewport.height}px`;
    let hasTextLayer = false;
    try {
      const textContent = await page.streamTextContent();
      const items = textContent.items
        .filter((item) => item.transform !== undefined)
        .map((item) => {
          const geometry: { str: string; transform: number[]; width?: number; height?: number; hasEOL?: boolean } = {
            str: item.str,
            transform: item.transform as number[],
          };
          if (item.width !== undefined) geometry.width = item.width;
          if (item.height !== undefined) geometry.height = item.height;
          if (item.hasEOL !== undefined) geometry.hasEOL = item.hasEOL;
          return geometry;
        });
      hasTextLayer = items.length > 0;
      buildPdfTextLayer({
        pageElement: this.textLayer,
        items,
        pageDims: this.pageBaseDims,
        scale: this.displayScale,
      });
    } catch (error) {
      if (!this.disposed && this.generation === generation) {
        this.callbacks.onError?.(error);
      }
      // 文本层是可选增强,图像仍可作为扫描页正文继续显示。
    }

    if (this.disposed || this.generation !== generation) {
      return;
    }

    this.element.dataset.textSelectable = String(hasTextLayer);
    if (hasTextLayer) {
      this.scanNotice.remove();
    } else if (!this.scanNotice.isConnected) {
      this.element.appendChild(this.scanNotice);
    }

    // 重渲染后按归一化矩形重绘批注/搜索高亮,保证缩放或适配变化后仍对齐正文。
    this.redrawHighlights();
  }

  /** 设置本页待绘制的高亮矩形列表(归一化),并立即重绘覆盖层。 */
  setHighlights(highlights: PdfHighlight[]): void {
    this.pendingHighlights = highlights;
    this.redrawHighlights();
  }

  private getPageRect(): DOMRect | { left: number; top: number; width: number; height: number } {
    const rect = this.element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width || parseFloat(this.element.style.width) || 0,
      height: rect.height || parseFloat(this.element.style.height) || 0,
    };
  }

  private clearAreaSelection(): void {
    this.areaStart = null;
    this.areaPointerId = null;
    this.areaSelectionLayer.replaceChildren();
    this.element.classList.remove('pdf-area-selecting');
  }

  private drawAreaPreview(start: PdfPointerPoint, end: PdfPointerPoint): void {
    const pageRect = this.getPageRect();
    const rect = normalizeRectFromPoints(start, end, pageRect);
    if (!rect) return;
    const preview = document.createElement('div');
    preview.className = 'pdf-area-selection';
    preview.style.position = 'absolute';
    preview.style.left = `${(rect.x * pageRect.width).toFixed(2)}px`;
    preview.style.top = `${(rect.y * pageRect.height).toFixed(2)}px`;
    preview.style.width = `${(rect.width * pageRect.width).toFixed(2)}px`;
    preview.style.height = `${(rect.height * pageRect.height).toFixed(2)}px`;
    preview.style.backgroundColor = 'rgba(56, 189, 248, 0.22)';
    preview.style.border = '1px solid rgba(125, 211, 252, 0.95)';
    this.areaSelectionLayer.replaceChildren(preview);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.disposed || event.button !== 0 || this.element.dataset.textSelectable !== 'false') {
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    this.areaStart = point;
    this.areaPointerId = event.pointerId;
    this.element.classList.add('pdf-area-selecting');
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      // jsdom and older WebViews may not expose pointer capture.
    }
    event.preventDefault();
    this.drawAreaPreview(point, point);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.areaStart || this.areaPointerId !== event.pointerId) return;
    event.preventDefault();
    this.drawAreaPreview(this.areaStart, { x: event.clientX, y: event.clientY });
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.areaStart || this.areaPointerId !== event.pointerId) return;
    const start = this.areaStart;
    const end = { x: event.clientX, y: event.clientY };
    const pageRect = this.getPageRect();
    const rect = normalizeRectFromPoints(start, end, pageRect);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    this.clearAreaSelection();
    if (!rect || width < 4 || height < 4) return;
    this.callbacks.onAreaSelection?.({
      page: Number(this.element.dataset.page ?? 0),
      rect,
      clientRect: {
        left: pageRect.left + rect.x * pageRect.width,
        top: pageRect.top + rect.y * pageRect.height,
        width: rect.width * pageRect.width,
        height: rect.height * pageRect.height,
      },
    });
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    if (this.areaPointerId === event.pointerId) {
      this.clearAreaSelection();
    }
  };

  /** 读取本页当前的显示尺寸(供上层换算归一化矩形)。 */
  getDisplayDims(): { displayWidth: number; displayHeight: number } {
    return {
      displayWidth: this.canvas.style.width ? parseFloat(this.canvas.style.width) || 0 : 0,
      displayHeight: this.canvas.style.height ? parseFloat(this.canvas.style.height) || 0 : 0,
    };
  }

  /** 按归一化矩形重绘高亮覆盖层(幂等:先清空再绘制)。 */
  private redrawHighlights(): void {
    this.highlightLayer.replaceChildren();
    if (this.pendingHighlights.length === 0) {
      return;
    }
    const { displayWidth, displayHeight } = this.getDisplayDims();
    if (displayWidth <= 0 || displayHeight <= 0) {
      return;
    }
    for (const { rect, color } of this.pendingHighlights) {
      const el = document.createElement('div');
      el.className = 'pdf-highlight';
      el.style.position = 'absolute';
      el.style.left = `${(rect.x * displayWidth).toFixed(2)}px`;
      el.style.top = `${(rect.y * displayHeight).toFixed(2)}px`;
      el.style.width = `${(rect.width * displayWidth).toFixed(2)}px`;
      el.style.height = `${(rect.height * displayHeight).toFixed(2)}px`;
      el.style.backgroundColor = color;
      el.style.opacity = '0.35';
      el.style.pointerEvents = 'none';
      this.highlightLayer.appendChild(el);
    }
  }

  /** 返回当前已分配的位图面积(像素),供内存预算统计。位图已释放时返回 0。 */
  getBitmapArea(): number {
    if (this.disposed) {
      return 0;
    }
    return this.canvas.width * this.canvas.height;
  }

  /** 释放本页:取消在途渲染、回收位图与文本层。 */
  release(): void {
    this.disposed = true;
    this.clearAreaSelection();
    this.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerup', this.handlePointerUp);
    this.element.removeEventListener('pointercancel', this.handlePointerCancel);
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.textLayer.replaceChildren();
    this.element.remove();
  }
}

export { MAX_RENDER_DPR, MAX_CANVAS_PIXELS };
