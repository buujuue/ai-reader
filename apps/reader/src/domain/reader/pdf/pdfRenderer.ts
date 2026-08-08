import type { PdfFitMode } from '../readingLocation';
import type { PdfDocumentProxy, PdfJsLib, PdfPage } from './pdfLibrary';
import { PdfPageRenderer, type PdfPageRasterizer } from './pdfPageRenderer';
import type { PdfHighlight } from './pdfTextAnchor';

/** 解码页面对象缓存上限(LRU)。解码对象比画布位图廉价,但超出后仍应 `cleanup()` 回收。 */
export const DEFAULT_MAX_DECODED_PAGES = 16;
/** 同时保持已光栅化画布的窗口大小(滚动模式视口附近),超出即释放位图。 */
export const DEFAULT_RENDER_WINDOW = 8;

/** 分页/滚动间共用的页面间距(px)。 */
const PAGE_GAP = 20;

/** 渲染器回调:向 BookDocument 上报当前页码与滚动位移。 */
export interface PdfRendererCallbacks {
  onPageChange: (page: number) => void;
  onScroll: (scrollTop: number, page: number) => void;
  /** 某一页已渲染完成(分页或滚动窗口内),供上层重绘该页高亮。 */
  onPageRendered?: (page: number) => void;
}

export interface PdfRendererOptions {
  document: PdfDocumentProxy;
  container: HTMLElement;
  /** PDF.js 库(创建文本层/渲染依赖的 API 已收敛到 PdfPageRenderer,此处仅解析)。 */
  lib: PdfJsLib;
  /** 页面光栅化函数(生产用真实渲染,测试注入伪实现)。 */
  rasterize?: PdfPageRasterizer | undefined;
  maxDecodedPages?: number;
  renderWindow?: number;
  /** 设备像素比(生产读真实值,测试注入固定值)。 */
  devicePixelRatio?: () => number;
}

/** 单一页面的布局信息:显示尺寸与容器内垂直偏移。 */
interface PageLayout {
  pageNumber: number;
  width: number;
  height: number;
  top: number;
}

/**
 * PDF 固定版式渲染器:在容器内以分页或滚动方式呈现页面,负责布局、缩放/适配、
 * 视口窗口化与画布内存预算。外部(BookDocument)只通过窄方法驱动它,不直接
 * 操纵页面 DOM 或 PDF.js 对象。
 */
export class PdfRenderer {
  private readonly document: PdfDocumentProxy;
  private readonly container: HTMLElement;
  private readonly pages: HTMLElement;
  private readonly rasterize: PdfPageRasterizer;
  private readonly maxDecodedPages: number;
  private readonly renderWindow: number;
  private readonly getDpr: () => number;

  private flow: 'paginated' | 'scrolled' = 'paginated';
  private zoom = 100;
  private fit: PdfFitMode = 'width';

  private currentPage = 1;
  private layouts: PageLayout[] = [];
  private pageRenderers = new Map<number, PdfPageRenderer>();
  private pageCache = new Map<number, Promise<PdfPage>>();
  private resizeObserver: ResizeObserver | null = null;
  private lastScrollWindowKey = '';
  private disposed = false;

  constructor(
    options: PdfRendererOptions,
    private readonly callbacks: PdfRendererCallbacks,
  ) {
    this.document = options.document;
    this.getDpr = options.devicePixelRatio ?? (() => window.devicePixelRatio || 1);
    this.container = options.container;
    this.rasterize =
      options.rasterize ??
      ((page, canvas, scale) => {
        const context = canvas.getContext('2d');
        if (!context) {
          const task = {
            promise: Promise.resolve(),
            cancel: () => undefined,
          };
          return task;
        }
        return page.render({ canvasContext: context, viewport: page.getViewport({ scale }) });
      });
    this.maxDecodedPages = options.maxDecodedPages ?? DEFAULT_MAX_DECODED_PAGES;
    this.renderWindow = options.renderWindow ?? DEFAULT_RENDER_WINDOW;

    this.container.classList.add('pdf-renderer');
    this.container.style.position = 'relative';
    this.pages = document.createElement('div');
    this.pages.className = 'pdf-pages';
    this.container.appendChild(this.pages);
  }

  get pageCount(): number {
    return this.document.numPages;
  }

  getViewportState(): { zoom: number; fit: PdfFitMode } {
    return { zoom: this.zoom, fit: this.fit };
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  getScrollTop(): number {
    return this.container.scrollTop;
  }

  /** 读取指定页的渲染器(仅当该页已挂载时存在)。 */
  getPageRenderer(pageNumber: number): PdfPageRenderer | null {
    return this.pageRenderers.get(pageNumber) ?? null;
  }

  /** 把指定页面的高亮矩形(归一化)交给该页渲染器绘制。 */
  setPageHighlights(pageNumber: number, highlights: PdfHighlight[]): void {
    this.getPageRenderer(pageNumber)?.setHighlights(highlights);
  }

  /** 挂载并开始监听容器尺寸。 */
  async mount(): Promise<void> {
    this.resizeObserver = new ResizeObserver(() => this.relayout());
    this.resizeObserver.observe(this.container);
    await this.relayout();
  }

  setFlow(flow: 'paginated' | 'scrolled'): void {
    if (this.flow === flow) {
      return;
    }
    this.flow = flow;
    this.container.style.overflow = flow === 'scrolled' ? 'auto' : 'hidden';
    void this.relayout();
  }

  setViewport(zoom: number, fit: PdfFitMode): void {
    this.zoom = zoom;
    this.fit = fit;
    void this.relayout();
  }

  async goToPage(page: number): Promise<void> {
    const target = Math.min(Math.max(1, page), this.pageCount);
    if (this.flow === 'paginated') {
      this.currentPage = target;
      await this.relayout();
      this.callbacks.onPageChange(this.currentPage);
    } else {
      const layout = this.layouts[target - 1];
      if (layout) {
        this.container.scrollTop = layout.top;
        this.handleScroll();
      }
    }
  }

  setScrollTop(top: number): void {
    this.container.scrollTop = top;
    this.handleScroll();
  }

  /** 重新计算布局与渲染窗口。 */
  async relayout(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const clientWidth = this.container.clientWidth || 1;
    const clientHeight = this.container.clientHeight || 1;

    if (this.flow === 'paginated') {
      await this.renderPaginated(clientWidth, clientHeight);
    } else {
      await this.renderScrolled(clientWidth);
    }
  }

  private async renderPaginated(clientWidth: number, clientHeight: number): Promise<void> {
    const page = await this.acquirePage(this.currentPage);
    const scale = this.fitScale(page, clientWidth, clientHeight);
    const viewport = page.getViewport({ scale });

    this.pages.style.height = '100%';
    this.pages.style.display = 'flex';
    this.pages.style.alignItems = 'center';
    this.pages.style.justifyContent = 'center';

    const renderer = this.ensurePageRenderer(this.currentPage);
    for (const [pageNumber, existing] of this.pageRenderers) {
      if (pageNumber !== this.currentPage) {
        existing.release();
        this.pageRenderers.delete(pageNumber);
      }
    }
    this.pages.replaceChildren(renderer.element);
    renderer.element.style.width = `${viewport.width}px`;
    renderer.element.style.height = `${viewport.height}px`;
    await renderer.render(page, viewport, this.getDpr());
    this.callbacks.onPageRendered?.(this.currentPage);
  }

  private async renderScrolled(clientWidth: number): Promise<void> {
    // 先构建全部页面的布局(仅需 getViewport,不实际光栅化),保证总高与偏移正确。
    if (this.layouts.length !== this.pageCount) {
      this.layouts = [];
      let top = 0;
      for (let i = 1; i <= this.pageCount; i += 1) {
        const page = await this.acquirePage(i);
        const scale = this.scrollScale(page, clientWidth);
        const viewport = page.getViewport({ scale });
        this.layouts.push({
          pageNumber: i,
          width: viewport.width,
          height: viewport.height,
          top,
        });
        top += viewport.height + PAGE_GAP;
      }
    }

    this.pages.style.display = 'block';
    this.pages.style.height = `${this.layouts.reduce((sum, l) => sum + l.height + PAGE_GAP, 0)}px`;

    const viewportTop = this.container.scrollTop;
    const viewportBottom = viewportTop + this.container.clientHeight;
    const visible = this.layouts.filter(
      (layout) =>
        layout.top + layout.height >= viewportTop - this.renderWindow * PAGE_GAP &&
        layout.top <= viewportBottom + this.renderWindow * PAGE_GAP,
    );
    const visibleSet = new Set(visible.map((layout) => layout.pageNumber));

    // 窗口未变化时跳过重渲染,避免每次滚动都重绘画布。
    const windowKey = `${visible[0]?.pageNumber ?? 0}-${visible.at(-1)?.pageNumber ?? 0}`;
    if (windowKey === this.lastScrollWindowKey) {
      return;
    }
    this.lastScrollWindowKey = windowKey;

    this.pages.replaceChildren();

    const renderPromises: Array<Promise<void>> = [];
    for (const layout of visible) {
      const renderer = this.ensurePageRenderer(layout.pageNumber);
      renderer.element.style.position = 'absolute';
      renderer.element.style.left = '0';
      renderer.element.style.top = `${layout.top}px`;
      renderer.element.style.width = `${layout.width}px`;
      renderer.element.style.height = `${layout.height}px`;
      this.pages.appendChild(renderer.element);
      const page = await this.acquirePage(layout.pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = layout.width / (base.width || 1);
      renderPromises.push(
        renderer.render(page, page.getViewport({ scale }), this.getDpr()),
      );
    }

    // 释放离开窗口的页面画布位图(内存预算)。
    for (const [pageNumber, existing] of this.pageRenderers) {
      if (!visibleSet.has(pageNumber)) {
        existing.release();
        this.pageRenderers.delete(pageNumber);
      }
    }

    // 当前页码由调用方(setScrollTop / goToPage)在 handleScroll 中维护,这里不回调,
    // 避免 relayout → renderScrolled → handleScroll → relayout 的无限递归。
    await Promise.all(renderPromises);
    // 滚动窗口渲染完成后逐一重绘各页高亮,保证离开窗口再回来时批注/搜索高亮不丢失。
    for (const layout of visible) {
      this.callbacks.onPageRendered?.(layout.pageNumber);
    }
  }

  /** 滚动模式下页面显示缩放:非 actual 一律按容器宽度适配。 */
  private scrollScale(page: PdfPage, clientWidth: number): number {
    if (this.fit === 'actual') {
      return this.zoom / 100;
    }
    const baseWidth = page.getViewport({ scale: 1 }).width || 1;
    return clientWidth / baseWidth;
  }

  private fitScale(page: PdfPage, clientWidth: number, clientHeight: number): number {
    const base = page.getViewport({ scale: 1 });
    const baseWidth = base.width || 1;
    const baseHeight = base.height || 1;
    switch (this.fit) {
      case 'width':
        return clientWidth / baseWidth;
      case 'height':
        return clientHeight / baseHeight;
      case 'page':
        return Math.min(clientWidth / baseWidth, clientHeight / baseHeight);
      case 'actual':
        return this.zoom / 100;
    }
  }

  private ensurePageRenderer(pageNumber: number): PdfPageRenderer {
    const existing = this.pageRenderers.get(pageNumber);
    if (existing) {
      return existing;
    }
    const renderer = new PdfPageRenderer(pageNumber, this.rasterize);
    this.pageRenderers.set(pageNumber, renderer);
    return renderer;
  }

  private acquirePage(pageNumber: number): Promise<PdfPage> {
    const cached = this.pageCache.get(pageNumber);
    if (cached) {
      return cached;
    }
    const promise = this.document.getPage(pageNumber).then((page) => page);
    this.pageCache.set(pageNumber, promise);
    // LRU 上限:超出后清理最旧解码页,释放其内部缓存。
    while (this.pageCache.size > this.maxDecodedPages) {
      const oldestKey = this.pageCache.keys().next().value as number;
      const oldest = this.pageCache.get(oldestKey);
      this.pageCache.delete(oldestKey);
      void oldest?.then((page) => page.cleanup()).catch(() => undefined);
    }
    return promise;
  }

  private handleScroll(): void {
    if (this.flow !== 'scrolled') {
      return;
    }
    const scrollTop = this.container.scrollTop;
    let page = 1;
    for (let i = 0; i < this.layouts.length; i += 1) {
      if (this.layouts[i]!.top <= scrollTop + 1) {
        page = this.layouts[i]!.pageNumber;
      } else {
        break;
      }
    }
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.callbacks.onPageChange(page);
    }
    this.callbacks.onScroll(scrollTop, this.currentPage);
    // 滚动位置变化时按需重排可见窗口(懒节流由调用方负责)。
    void this.relayout();
  }

  dispose(): void {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const renderer of this.pageRenderers.values()) {
      renderer.release();
    }
    this.pageRenderers.clear();
    for (const promise of this.pageCache.values()) {
      void promise.then((page) => page.cleanup()).catch(() => undefined);
    }
    this.pageCache.clear();
    this.layouts = [];
    this.pages.remove();
  }
}