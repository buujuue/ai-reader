import type { PdfPage, PdfRenderTask, PdfViewport } from './pdfLibrary';

/** 页面光栅化函数:把某一页以给定缩放绘制到 canvas。生产用 PDF.js page.render,
 *  测试注入伪实现以在无真实 canvas 2d 环境下验证协调逻辑。返回渲染任务(可取消)。 */
export type PdfPageRasterizer = (
  page: PdfPage,
  canvas: HTMLCanvasElement,
  scale: number,
) => PdfRenderTask;

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

  private page: PdfPage | null = null;
  private displayScale = 1;
  private renderTask: PdfRenderTask | null = null;
  private generation = 0;
  private disposed = false;

  constructor(
    pageNumber: number,
    private readonly rasterize: PdfPageRasterizer,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'pdf-page';
    this.element.dataset.page = String(pageNumber);

    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.element.appendChild(this.canvas);

    this.textLayer = document.createElement('div');
    this.textLayer.className = 'pdf-text-layer';
    this.element.appendChild(this.textLayer);
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
    this.displayScale = viewport.width / (page.getViewport({ scale: 1 }).width || 1);

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
    } catch {
      // 渲染被取消或失败:释放位图,避免占用 GPU 内存。
      this.canvas.width = 0;
      this.canvas.height = 0;
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
    try {
      const textContent = await page.streamTextContent();
      for (const item of textContent.items) {
        if (item.str) {
          const span = document.createElement('span');
          span.textContent = item.str;
          this.textLayer.appendChild(span);
        }
      }
    } catch {
      // 文本层失败不影响页面图像显示。
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