import type { PdfFitMode } from '../readingLocation';
import type { AreaSelection, ReaderRuntimeResourceUsage } from '../bookDocument';
import type { PdfDocumentProxy, PdfJsLib, PdfPage } from './pdfLibrary';
import { PdfPageRenderer, type PdfPageRasterizer } from './pdfPageRenderer';
import type { PdfHighlight } from './pdfTextAnchor';

/** 解码页面对象缓存上限(LRU)。解码对象比画布位图廉价,但超出后仍应 `cleanup()` 回收。 */
export const DEFAULT_MAX_DECODED_PAGES = 16;
/** 滚动模式预加载窗口相对视口的倍数(IntersectionObserver rootMargin)。 */
export const DEFAULT_RENDER_WINDOW = 2;
/** 滚动模式同时保持的已光栅化页面上限。 */
export const DEFAULT_MAX_RENDERED_PAGES = 12;
/** 滚动模式同时进行页面读取/渲染的上限。 */
export const DEFAULT_MAX_CONCURRENT_PAGE_LOADS = 3;

/** 未取得真实 PDF 页面对象前使用的稳定占位尺寸。 */
const DEFAULT_PAGE_WIDTH = 595;
const DEFAULT_PAGE_HEIGHT = 842;

/** 分页/滚动间共用的页面间距(px)。 */
const PAGE_GAP = 20;

/** 渲染器回调:向 BookDocument 上报当前页码与滚动位移。 */
export interface PdfRendererCallbacks {
  onPageChange: (page: number) => void;
  onScroll: (scrollTop: number, page: number) => void;
  /** 某一页已渲染完成(分页或滚动窗口内),供上层重绘该页高亮。 */
  onPageRendered?: (page: number) => void;
  /** 扫描页区域拖选完成,供 PdfBookDocument 转发到工具栏。 */
  onAreaSelection?: (selection: AreaSelection) => void;
  /** 页面范围读取或渲染失败时的诊断回调。 */
  onError?: (error: unknown) => void;
}

export interface PdfRendererNavigationOptions {
  /** 这是一次显式阅读位置恢复,恢复前启动的异步布局不得提交结果。 */
  restore?: boolean;
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
  maxRenderedPages?: number;
  maxConcurrentPageLoads?: number;
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

interface ScrollAnchor {
  pageNumber: number;
  fraction: number;
  /** 当前 scrollTop 落在页间距或页外边界时,保留整份文档的绝对位置。 */
  scrollTop: number;
  isAbsolute: boolean;
}

interface ScrolledPageState {
  pageNumber: number;
  element: HTMLElement;
  layout: PageLayout;
  naturalWidth: number;
  naturalHeight: number;
  visible: boolean;
  state: 'idle' | 'loading' | 'loaded' | 'error';
  generation: number;
  page: PdfPage | null;
  renderer: PdfPageRenderer | null;
}

interface CachedPageRender {
  key: string;
  promise: Promise<void>;
}

/**
 * PDF 固定版式渲染器:在容器内以分页或滚动方式呈现页面,负责布局、缩放/适配、
 * 视口窗口化与画布内存预算。外部(BookDocument)只通过窄方法驱动它,不直接
 * 操纵页面 DOM 或 PDF.js 对象。
 */
export class PdfRenderer {
  private readonly document: PdfDocumentProxy;
  private container: HTMLElement;
  private readonly pages: HTMLElement;
  private readonly rasterize: PdfPageRasterizer;
  private readonly maxDecodedPages: number;
  private readonly renderWindow: number;
  private readonly maxRenderedPages: number;
  private readonly maxConcurrentPageLoads: number;
  private readonly getDpr: () => number;

  private flow: 'paginated' | 'scrolled' = 'paginated';
  private zoom = 100;
  private fit: PdfFitMode = 'width';

  private currentPage = 1;
  private layouts: PageLayout[] = [];
  private pageRenderers = new Map<number, PdfPageRenderer>();
  private pageCache = new Map<number, Promise<PdfPage>>();
  /** 分页模式的一页前瞻渲染缓存;滚动模式不使用它。 */
  private paginatedRenders = new Map<number, CachedPageRender>();
  /** 滚动模式的渲染结果缓存,窗口变化时复用仍在窗口内的页面。 */
  private scrolledRenders = new Map<number, CachedPageRender>();
  /** 滚动模式的页面占位与调度状态;占位本身不触发 PDF.js getPage。 */
  private scrolledPages: ScrolledPageState[] = [];
  private scrollObserver: IntersectionObserver | null = null;
  private scrollIntersectionReported = false;
  private scrollLoadingCount = 0;
  private pendingScrollAnchor: ScrollAnchor | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** 滚动布局对应的容器宽度;宽度变化时必须重新计算页面 top/height。 */
  private layoutWidth = 0;
  /** 每次 attach/detach 都推进,使旧容器观察器的迟到回调失效。 */
  private observerGeneration = 0;
  /** 只允许最新一次异步重排提交 DOM,避免尺寸/翻页竞态写回过期页面。 */
  private layoutGeneration = 0;
  /** 显式阅读位置恢复代次;异步页面加载需与它同时有效才能改写布局。 */
  private restoreGeneration = 0;
  private activeRestore: { generation: number; pageNumber: number } | null = null;
  private disposed = false;
  private suspended = false;

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
    this.maxRenderedPages = Math.max(1, options.maxRenderedPages ?? DEFAULT_MAX_RENDERED_PAGES);
    this.maxConcurrentPageLoads = Math.max(
      1,
      options.maxConcurrentPageLoads ?? DEFAULT_MAX_CONCURRENT_PAGE_LOADS,
    );

    this.container.classList.add('pdf-renderer');
    this.container.style.position = 'relative';
    this.applyContainerFlow();
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

  /** 返回当前 PDF 页面窗口所占用的可获得资源快照。 */
  getRuntimeResourceUsage(): ReaderRuntimeResourceUsage {
    let canvasCount = 0;
    let estimatedBytes = 0;
    for (const renderer of this.pageRenderers.values()) {
      const bitmapArea = renderer.getBitmapArea();
      if (bitmapArea <= 0) continue;
      canvasCount += 1;
      estimatedBytes += bitmapArea * 4;
    }
    const decodedPageCount = this.pageCache.size;
    // PDF.js 页面对象的内部结构由引擎决定，不能读取私有字段；用保守的
    // 固定页对象开销计入估算，只把硬上限交给页面数和 Canvas 像素预算。
    estimatedBytes += decodedPageCount * 128 * 1024;
    return {
      iframeCount: 0,
      canvasCount,
      decodedPageCount,
      rangeCacheBytes: 0,
      estimatedBytes,
    };
  }

  /** 挂载并开始监听容器尺寸。 */
  async mount(): Promise<void> {
    this.attachObservers();
    await this.relayout();
  }

  /**
   * 从当前 ReadingView 摘下页面 DOM 和活动观察器，但保留 PDF.js 文档、当前页
   * 的 Canvas/文本层以及可恢复位置。只在重新 attach 或 dispose 时继续拥有它们。
   */
  detach(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    this.layoutGeneration += 1;
    this.restoreGeneration += 1;
    this.activeRestore = null;
    this.detachObservers();
    this.shrinkToSuspendedWindow();
    this.pages.remove();
  }

  /** 将同一 PDF.js 文档的页面窗口重新挂回新的 ReadingView 容器。 */
  attach(container: HTMLElement): boolean {
    if (this.disposed) {
      return false;
    }
    this.pages.remove();
    this.container = container;
    this.container.classList.add('pdf-renderer');
    this.container.style.position = 'relative';
    this.applyContainerFlow();
    this.container.appendChild(this.pages);
    this.suspended = false;
    this.layoutGeneration += 1;
    this.restoreGeneration += 1;
    this.activeRestore = null;
    this.attachObservers();
    if (!this.suspended) void this.relayout();
    return true;
  }

  setFlow(flow: 'paginated' | 'scrolled'): void {
    if (this.flow === flow) {
      return;
    }
    if (this.flow === 'scrolled') {
      this.destroyScrolledMode();
    }
    this.flow = flow;
    this.invalidateLayout();
    this.applyContainerFlow();
    if (!this.suspended) void this.relayout();
  }

  /** 容器会在 Runtime 回切时替换，模式相关样式必须随 attach 重新应用。 */
  private applyContainerFlow(): void {
    this.container.style.overflow = this.flow === 'scrolled' ? 'auto' : 'hidden';
  }

  setViewport(zoom: number, fit: PdfFitMode): void {
    this.zoom = zoom;
    this.fit = fit;
    // 适配模式/缩放会改变滚动模式下每一页的尺寸和 top 偏移。旧布局
    // 不能用于恢复页码,否则会把保存的 scrollTop 映射到旧页面几何上。
    this.invalidateLayout();
    if (!this.suspended) void this.relayout();
  }

  async goToPage(
    page: number,
    scrollTop?: number,
    options: PdfRendererNavigationOptions = {},
  ): Promise<void> {
    const target = Math.min(Math.max(1, page), this.pageCount);
    const restoreGeneration = options.restore
      ? ++this.restoreGeneration
      : this.restoreGeneration;
    if (options.restore) {
      this.activeRestore = { generation: restoreGeneration, pageNumber: target };
      // 显式位置优先于旧容器留下的比例/绝对锚点。目标位置会在布局完成后
      // 由本次 goToPage 直接应用。
      this.pendingScrollAnchor = null;
    }
    try {
      if (this.flow === 'paginated') {
        this.currentPage = target;
        await this.relayout();
        if (restoreGeneration !== this.restoreGeneration) return;
        this.callbacks.onPageChange(this.currentPage);
      } else {
        // setFlow/setViewport 会主动使滚动布局失效。恢复位置紧接着发生时,
        // 必须先完成新视口下的布局,再按目标页设置滚动位置。
        const clientWidth = this.container.clientWidth || 1;
        if (this.layouts.length !== this.pageCount || this.layoutWidth !== clientWidth) {
          await this.relayout();
        }
        if (restoreGeneration !== this.restoreGeneration) return;
        const layout = this.layouts[target - 1];
        if (layout) {
          // scrollTop 是相对于整份滚动文档的绝对位置。不能用目标页的
          // bottom 校验它:页底到下一页 top 之间的间距也是合法阅读位置,
          // 而且最后一页之后的边界只能由整个滚动容器决定。
          const requestedScrollTop =
            scrollTop !== undefined && Number.isFinite(scrollTop) ? scrollTop : layout.top;
          const maxScrollTop = this.getMaxScrollTop();
          const appliedScrollTop = Math.min(maxScrollTop, Math.max(0, requestedScrollTop));
          this.container.scrollTop = appliedScrollTop;
          this.handleScroll();
          // 目录、位置恢复和批注跳转需要在返回前至少完成目标页附近的
          // 调度,避免调用方立刻读取目标页面渲染器时只得到占位。
          await this.relayout();
        }
      }
    } finally {
      if (options.restore && this.activeRestore?.generation === restoreGeneration) {
        this.activeRestore = null;
      }
    }
  }

  setScrollTop(top: number): void {
    this.container.scrollTop = top;
    this.handleScroll();
  }

  /** 重新计算布局与渲染窗口。 */
  async relayout(): Promise<void> {
    if (this.disposed || this.suspended) {
      return;
    }
    const generation = ++this.layoutGeneration;
    const restoreGeneration = this.restoreGeneration;
    const clientWidth = this.container.clientWidth || 1;
    const clientHeight = this.container.clientHeight || 1;

    if (this.flow === 'paginated') {
      await this.renderPaginated(clientWidth, clientHeight, generation, restoreGeneration);
    } else {
      await this.renderScrolled(clientWidth, generation, restoreGeneration);
    }
  }

  private async renderPaginated(
    clientWidth: number,
    clientHeight: number,
    generation: number,
    restoreGeneration: number,
  ): Promise<void> {
    const pageNumber = this.currentPage;
    const page = await this.acquirePage(pageNumber);
    if (!this.isCurrentLayout(generation, pageNumber, restoreGeneration)) {
      return;
    }
    const scale = this.fitScale(page, clientWidth, clientHeight);
    const viewport = page.getViewport({ scale });
    const renderKey = this.getPaginatedRenderKey(viewport);

    this.pages.style.height = '100%';
    this.pages.style.display = 'flex';
    this.pages.style.alignItems = 'center';
    this.pages.style.justifyContent = 'center';

    const renderer = this.ensurePageRenderer(pageNumber);
    for (const [cachedPageNumber, existing] of this.pageRenderers) {
      if (cachedPageNumber !== pageNumber && cachedPageNumber !== pageNumber + 1) {
        this.releasePageRenderer(cachedPageNumber, existing);
      }
    }
    renderer.element.style.width = `${viewport.width}px`;
    renderer.element.style.height = `${viewport.height}px`;
    await this.renderCachedPage(
      this.paginatedRenders,
      pageNumber,
      renderer,
      page,
      viewport,
      renderKey,
    );
    if (!this.isCurrentLayout(generation, pageNumber, restoreGeneration)) {
      return;
    }
    this.pages.replaceChildren(renderer.element);
    this.callbacks.onPageRendered?.(pageNumber);
    this.preloadNextPaginatedPage(
      pageNumber,
      clientWidth,
      clientHeight,
      generation,
      restoreGeneration,
    );
  }

  /** 分页模式只把当前页和下一页保留在 DOM/渲染缓存范围内,避免扩大画布预算。 */
  private releasePageRenderer(pageNumber: number, renderer: PdfPageRenderer): void {
    renderer.release();
    this.pageRenderers.delete(pageNumber);
    this.paginatedRenders.delete(pageNumber);
    this.scrolledRenders.delete(pageNumber);
  }

  private getPaginatedRenderKey(viewport: { width: number; height: number }): string {
    return `${viewport.width}:${viewport.height}:${this.getDpr()}`;
  }

  /** 返回可复用的页面渲染任务,同一页/同一尺寸不会因窗口变化再次光栅化。 */
  private renderCachedPage(
    cache: Map<number, CachedPageRender>,
    pageNumber: number,
    renderer: PdfPageRenderer,
    page: PdfPage,
    viewport: { width: number; height: number },
    key: string,
  ): Promise<void> {
    const cached = cache.get(pageNumber);
    if (cached?.key === key) {
      return cached.promise;
    }

    let promise: Promise<void>;
    promise = renderer.render(page, viewport, this.getDpr()).catch((error: unknown) => {
      if (cache.get(pageNumber)?.promise === promise) {
        cache.delete(pageNumber);
      }
      throw error;
    });
    cache.set(pageNumber, { key, promise });
    return promise;
  }

  /** 当前页可见后尽早预渲染下一页;失败只影响下一页,不阻塞当前阅读。 */
  private preloadNextPaginatedPage(
    pageNumber: number,
    clientWidth: number,
    clientHeight: number,
    generation: number,
    restoreGeneration: number,
  ): void {
    const nextPageNumber = pageNumber + 1;
    if (nextPageNumber > this.pageCount) {
      return;
    }

    void (async () => {
      try {
        const nextPage = await this.acquirePage(nextPageNumber);
        if (!this.isCurrentLayout(generation, pageNumber, restoreGeneration)) {
          return;
        }
        const nextScale = this.fitScale(nextPage, clientWidth, clientHeight);
        const nextViewport = nextPage.getViewport({ scale: nextScale });
        const nextRenderer = this.ensurePageRenderer(nextPageNumber);
        nextRenderer.element.style.width = `${nextViewport.width}px`;
        nextRenderer.element.style.height = `${nextViewport.height}px`;
        await this.renderCachedPage(
          this.paginatedRenders,
          nextPageNumber,
          nextRenderer,
          nextPage,
          nextViewport,
          this.getPaginatedRenderKey(nextViewport),
        );
        if (this.isCurrentLayout(generation, pageNumber, restoreGeneration)) {
          this.callbacks.onPageRendered?.(nextPageNumber);
        }
      } catch {
        // 预加载是最佳努力路径;下一次真正翻到该页时会重新尝试渲染。
      }
    })();
  }

  private async renderScrolled(
    clientWidth: number,
    generation: number,
    restoreGeneration: number,
  ): Promise<void> {
    this.ensureScrolledPages();
    if (!this.isCurrentLayout(generation, undefined, restoreGeneration)) {
      return;
    }

    this.ensureScrollObserver();
    if (this.layouts.length !== this.pageCount || this.layoutWidth !== clientWidth) {
      this.rebuildScrolledLayouts(clientWidth, generation, restoreGeneration);
    } else {
      this.applyScrolledPageStyles();
    }
    if (!this.isCurrentLayout(generation, undefined, restoreGeneration)) {
      return;
    }

    this.refreshFallbackScrollVisibility();
    // 已取得页面的缩放重绘也走同一调度器,避免一次缩放同时启动超过 3 个
    // Canvas/文字层任务;未知页面仍保持占位,不为了计算总高度调用 getPage。
    await this.scheduleScrollPages();
    if (!this.isCurrentLayout(generation, undefined, restoreGeneration)) {
      return;
    }
  }

  /** 创建与页数等长的占位 DOM;占位尺寸先使用稳定的通用 PDF 页面尺寸。 */
  private ensureScrolledPages(): void {
    if (this.scrolledPages.length === this.pageCount) {
      return;
    }

    this.destroyScrollObserver();
    this.scrolledPages = [];
    this.pages.replaceChildren();
    this.pages.style.position = 'relative';
    for (let index = 0; index < this.pageCount; index += 1) {
      const pageNumber = index + 1;
      const element = document.createElement('div');
      element.className = 'pdf-page-placeholder';
      element.dataset.page = String(pageNumber);
      element.style.position = 'absolute';
      element.style.left = '0';
      this.pages.appendChild(element);
      this.scrolledPages.push({
        pageNumber,
        element,
        layout: {
          pageNumber,
          width: DEFAULT_PAGE_WIDTH,
          height: DEFAULT_PAGE_HEIGHT,
          top: 0,
        },
        naturalWidth: DEFAULT_PAGE_WIDTH,
        naturalHeight: DEFAULT_PAGE_HEIGHT,
        visible: false,
        state: 'idle',
        generation: 0,
        page: null,
        renderer: null,
      });
    }
  }

  /** IntersectionObserver 只负责更新可见标志,调度仍由渲染器统一控制。 */
  private ensureScrollObserver(): void {
    if (this.scrollObserver || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observerGeneration = this.observerGeneration;
    this.scrollIntersectionReported = false;
    this.scrollObserver = new IntersectionObserver(
      (entries) => {
        if (!this.isCurrentObserver(observerGeneration)) return;
        this.scrollIntersectionReported = true;
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page ?? 0);
          const state = this.scrolledPages[pageNumber - 1];
          if (state) {
            state.visible = entry.isIntersecting;
          }
        }
        void this.scheduleScrollPages();
      },
      {
        root: this.container,
        rootMargin: `${this.renderWindow * 100}% 0px`,
      },
    );
    for (const state of this.scrolledPages) {
      this.scrollObserver.observe(state.element);
    }
  }

  private destroyScrollObserver(): void {
    this.scrollObserver?.disconnect();
    this.scrollObserver = null;
    this.scrollIntersectionReported = false;
  }

  private isCurrentObserver(generation: number): boolean {
    return generation === this.observerGeneration && !this.suspended && !this.disposed;
  }

  /** IntersectionObserver 尚未回报首批结果或浏览器不支持时的安全回退。 */
  private refreshFallbackScrollVisibility(): void {
    if (this.scrollIntersectionReported) {
      return;
    }
    const viewportTop = this.container.scrollTop;
    const viewportBottom = viewportTop + this.container.clientHeight;
    const margin = Math.max(this.container.clientHeight, DEFAULT_PAGE_HEIGHT) * this.renderWindow;
    for (const state of this.scrolledPages) {
      const { top, height } = state.layout;
      state.visible =
        top + height >= viewportTop - margin && top <= viewportBottom + margin;
    }
    this.scrolledPages[this.currentPage - 1]!.visible = true;
  }

  /** 重新计算所有占位的 top/height;未加载页不会触发页面对象读取。 */
  private rebuildScrolledLayouts(
    clientWidth: number,
    layoutGeneration = this.layoutGeneration,
    restoreGeneration = this.restoreGeneration,
  ): void {
    if (!this.isCurrentLayout(layoutGeneration, undefined, restoreGeneration)) {
      return;
    }
    const restoring = this.activeRestore?.generation === restoreGeneration;
    const anchor = restoring ? null : this.pendingScrollAnchor ?? this.captureScrollAnchor();
    this.pendingScrollAnchor = null;
    let top = 0;
    const layouts: PageLayout[] = [];
    for (const state of this.scrolledPages) {
      const scale = this.scrollScaleFromNaturalSize(state, clientWidth);
      const layout: PageLayout = {
        pageNumber: state.pageNumber,
        width: state.naturalWidth * scale,
        height: state.naturalHeight * scale,
        top,
      };
      state.layout = layout;
      layouts.push(layout);
      top += layout.height + PAGE_GAP;
    }
    this.layouts = layouts;
    this.layoutWidth = clientWidth;
    this.pages.style.display = 'block';
    this.pages.style.height = `${Math.max(0, top)}px`;
    this.applyScrolledPageStyles();
    if (restoring) {
      this.currentPage = this.activeRestore!.pageNumber;
    } else {
      this.restoreScrollAnchor(anchor);
      this.updateCurrentPageFromScroll();
    }
  }

  private applyScrolledPageStyles(): void {
    this.pages.style.display = 'block';
    for (const state of this.scrolledPages) {
      const { layout } = state;
      Object.assign(state.element.style, {
        position: 'absolute',
        left: '0',
        top: `${layout.top}px`,
        width: `${layout.width}px`,
        height: `${layout.height}px`,
      });
      if (state.renderer) {
        Object.assign(state.renderer.element.style, {
          position: 'absolute',
          left: '0',
          top: `${layout.top}px`,
          width: `${layout.width}px`,
          height: `${layout.height}px`,
        });
        if (!this.pages.contains(state.renderer.element)) {
          this.pages.appendChild(state.renderer.element);
        }
      }
    }
  }

  private scrollScaleFromNaturalSize(state: ScrolledPageState, clientWidth: number): number {
    if (this.fit === 'actual') {
      return this.zoom / 100;
    }
    return clientWidth / (state.naturalWidth || DEFAULT_PAGE_WIDTH);
  }

  private captureScrollAnchor(): ScrollAnchor | null {
    if (this.flow !== 'scrolled' || this.layouts.length === 0) {
      return null;
    }
    const scrollTop = this.container.scrollTop;
    const fallback = this.scrolledPages[this.currentPage - 1]?.layout;
    const layout = this.layouts.find(
      (candidate) =>
        candidate.height > 0 &&
        scrollTop >= candidate.top &&
        scrollTop < candidate.top + candidate.height,
    );
    const anchorLayout = layout ?? fallback;
    if (!anchorLayout) {
      return null;
    }
    return {
      pageNumber: anchorLayout.pageNumber,
      fraction: layout && layout.height > 0
        ? Math.min(1, Math.max(0, (scrollTop - layout.top) / layout.height))
        : 0,
      scrollTop,
      isAbsolute: layout === undefined,
    };
  }

  private restoreScrollAnchor(anchor: ScrollAnchor | null): void {
    if (!anchor || this.layouts.length === 0) {
      return;
    }
    const layout = this.layouts[anchor.pageNumber - 1];
    if (!layout) {
      return;
    }
    const maxScrollTop = this.getMaxScrollTop();
    // 页间距不是任何一页的内容。此时页码只能作为调度/显示提示,
    // 位置必须继续使用原始的整份文档绝对 scrollTop,否则会吸附到页底。
    const target = anchor.isAbsolute
      ? anchor.scrollTop
      : layout.top + layout.height * anchor.fraction;
    this.container.scrollTop = Math.min(maxScrollTop, Math.max(0, target));
  }

  private getScrollContentHeight(): number {
    const last = this.layouts.at(-1);
    return last ? last.top + last.height + PAGE_GAP : 0;
  }

  /** 滚动位置的唯一边界:整个 PDF 内容减去阅读容器视口高度。 */
  private getMaxScrollTop(): number {
    return Math.max(0, this.getScrollContentHeight() - Math.max(0, this.container.clientHeight));
  }

  private updateCurrentPageFromScroll(): void {
    const previousPage = this.currentPage;
    let page = 1;
    for (const layout of this.layouts) {
      if (layout.top <= this.container.scrollTop + 1) {
        page = layout.pageNumber;
      } else {
        break;
      }
    }
    this.currentPage = Math.min(this.pageCount, Math.max(1, page));
    if (this.currentPage !== previousPage) {
      this.callbacks.onPageChange(this.currentPage);
    }
  }

  /** 参考 Readest 的最近页优先计划,但只在 PdfRenderer 内部操作页面状态。 */
  private async scheduleScrollPages(): Promise<void> {
    if (this.disposed || this.suspended || this.flow !== 'scrolled' || this.scrolledPages.length === 0) {
      return;
    }
    const layoutGeneration = this.layoutGeneration;
    const restoreGeneration = this.restoreGeneration;
    this.refreshFallbackScrollVisibility();
    // IntersectionObserver 的异步回调可能落后于一次快速跳转,当前页必须
    // 始终是可调度目标,否则滚动到尚未回报的页面会短暂显示整块占位。
    this.scrolledPages[this.currentPage - 1]!.visible = true;
    const currentPage = this.currentPage;
    const distance = (state: ScrolledPageState) => Math.abs(state.pageNumber - currentPage);
    const budget = Math.max(0, this.maxConcurrentPageLoads - this.scrollLoadingCount);
    const toLoad = this.scrolledPages
      .filter((state) => state.visible && state.state === 'idle')
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, budget);

    const loaded = this.scrolledPages.filter((state) => state.state === 'loaded');
    if (loaded.length > this.maxRenderedPages) {
      const toEvict = loaded
        .filter((state) => !state.visible && state.pageNumber !== currentPage)
        .sort((a, b) => distance(b) - distance(a))
        .slice(0, loaded.length - this.maxRenderedPages);
      for (const state of toEvict) {
        this.releaseScrolledPage(state);
      }
    }

    const toRender = this.scrolledPages
      .filter(
        (state) =>
          state.visible &&
          state.state === 'loaded' &&
          state.page !== null &&
          state.renderer !== null &&
          this.needsScrolledRender(state),
      )
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, Math.max(0, budget - toLoad.length));

    this.scrollLoadingCount += toRender.length;
    try {
      await Promise.all([
        ...toLoad.map((state) => this.loadScrolledPage(state)),
        ...toRender.map((state) =>
          this.renderScrolledPageWithBudget(state, layoutGeneration, restoreGeneration),
        ),
      ]);
    } finally {
      this.scrollLoadingCount = Math.max(0, this.scrollLoadingCount - toRender.length);
      if (
        toRender.length > 0 &&
        !this.disposed &&
        !this.suspended &&
        this.flow === 'scrolled' &&
        layoutGeneration === this.layoutGeneration &&
        restoreGeneration === this.restoreGeneration
      ) {
        void this.scheduleScrollPages();
      }
    }
  }

  private needsScrolledRender(state: ScrolledPageState): boolean {
    const layout = state.layout;
    const key = `${layout.width}:${layout.height}:${this.getDpr()}`;
    return this.scrolledRenders.get(state.pageNumber)?.key !== key;
  }

  private async renderScrolledPageWithBudget(
    state: ScrolledPageState,
    layoutGeneration: number,
    restoreGeneration: number,
  ): Promise<void> {
    try {
      await this.renderLoadedScrolledPage(state, layoutGeneration, restoreGeneration);
    } catch (error) {
      this.callbacks.onError?.(error);
    }
  }

  private async loadScrolledPage(state: ScrolledPageState): Promise<void> {
    if (state.state !== 'idle' || this.disposed || this.flow !== 'scrolled') {
      return;
    }
    state.state = 'loading';
    const generation = ++state.generation;
    const restoreGeneration = this.restoreGeneration;
    this.scrollLoadingCount += 1;
    try {
      const page = await this.acquirePage(state.pageNumber);
      if (
        !this.isCurrentScrolledPage(state, generation) ||
        restoreGeneration !== this.restoreGeneration
      ) {
        this.resetStaleScrolledPageLoad(state, generation);
        return;
      }
      state.page = page;
      const base = page.getViewport({ scale: 1 });
      if (base.width > 0 && base.height > 0) {
        this.pendingScrollAnchor = this.captureScrollAnchor();
        state.naturalWidth = base.width;
        state.naturalHeight = base.height;
        // 页面实际尺寸到达时使用当前布局事务重算;恢复代次已在上方校验,
        // 因而不会把恢复前的页面结果带入新的位置锚点。
        this.rebuildScrolledLayouts(this.container.clientWidth || 1);
      }
      state.renderer = this.ensurePageRenderer(state.pageNumber);
      this.pages.appendChild(state.renderer.element);
      this.applyScrolledPageStyles();
      await this.renderLoadedScrolledPage(state, this.layoutGeneration, restoreGeneration);
      if (
        !this.isCurrentScrolledPage(state, generation) ||
        restoreGeneration !== this.restoreGeneration
      ) {
        this.resetStaleScrolledPageLoad(state, generation);
        return;
      }
      state.state = 'loaded';
    } catch (error) {
      const stillCurrent =
        this.isCurrentScrolledPage(state, generation) &&
        restoreGeneration === this.restoreGeneration;
      if (stillCurrent) {
        state.state = 'error';
        if (state.renderer) {
          this.releasePageRenderer(state.pageNumber, state.renderer);
          state.renderer = null;
        }
        this.callbacks.onError?.(error);
      } else {
        this.resetStaleScrolledPageLoad(state, generation);
      }
    } finally {
      this.scrollLoadingCount = Math.max(0, this.scrollLoadingCount - 1);
      if (!this.disposed && !this.suspended && this.flow === 'scrolled') {
        void this.scheduleScrollPages();
      }
    }
  }

  private isCurrentScrolledPage(state: ScrolledPageState, generation: number): boolean {
    return (
      !this.disposed &&
      !this.suspended &&
      this.flow === 'scrolled' &&
      state.generation === generation &&
      this.scrolledPages[state.pageNumber - 1] === state
    );
  }

  private async renderLoadedScrolledPage(
    state: ScrolledPageState,
    layoutGeneration: number,
    restoreGeneration: number,
  ): Promise<void> {
    const page = state.page;
    const renderer = state.renderer;
    if (!page || !renderer || this.disposed || this.flow !== 'scrolled') {
      return;
    }
    const layout = state.layout;
    const base = page.getViewport({ scale: 1 });
    const scale = layout.width / (base.width || 1);
    renderer.element.style.width = `${layout.width}px`;
    renderer.element.style.height = `${layout.height}px`;
    const key = `${layout.width}:${layout.height}:${this.getDpr()}`;
    const needsRender = this.scrolledRenders.get(state.pageNumber)?.key !== key;
    await this.renderCachedPage(
      this.scrolledRenders,
      state.pageNumber,
      renderer,
      page,
      page.getViewport({ scale }),
      key,
    );
    if (
      this.disposed ||
      this.flow !== 'scrolled' ||
      layoutGeneration !== this.layoutGeneration ||
      restoreGeneration !== this.restoreGeneration ||
      this.scrolledRenders.get(state.pageNumber)?.key !== key
    ) {
      return;
    }
    if (needsRender) {
      this.callbacks.onPageRendered?.(state.pageNumber);
    }
  }

  private releaseScrolledPage(state: ScrolledPageState): void {
    state.generation += 1;
    if (state.renderer) {
      this.releasePageRenderer(state.pageNumber, state.renderer);
      state.renderer = null;
    }
    state.state = 'idle';
    state.page = null;
    state.element.replaceChildren();
  }

  private resetStaleScrolledPageLoad(state: ScrolledPageState, generation: number): void {
    if (state.generation !== generation || state.state !== 'loading') return;
    state.generation += 1;
    if (state.renderer) {
      this.releasePageRenderer(state.pageNumber, state.renderer);
      state.renderer = null;
    }
    state.page = null;
    state.state = 'idle';
    state.element.replaceChildren();
  }

  private isCurrentLayout(
    generation: number,
    pageNumber?: number,
    restoreGeneration = this.restoreGeneration,
  ): boolean {
    return (
      !this.disposed &&
      !this.suspended &&
      generation === this.layoutGeneration &&
      restoreGeneration === this.restoreGeneration &&
      (pageNumber === undefined || pageNumber === this.currentPage)
    );
  }

  private invalidateLayout(): void {
    this.layoutGeneration += 1;
    if (this.flow === 'scrolled' && this.layouts.length > 0) {
      this.pendingScrollAnchor = this.captureScrollAnchor();
    }
    this.layouts = [];
    this.layoutWidth = 0;
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
    const renderer = new PdfPageRenderer(pageNumber, this.rasterize, {
      onAreaSelection: this.callbacks.onAreaSelection,
      onError: this.callbacks.onError,
    });
    this.pageRenderers.set(pageNumber, renderer);
    return renderer;
  }

  private acquirePage(pageNumber: number): Promise<PdfPage> {
    const cached = this.pageCache.get(pageNumber);
    if (cached) {
      return cached;
    }
    const promise = this.document.getPage(pageNumber).then((page) => page).catch((error: unknown) => {
      if (this.pageCache.get(pageNumber) === promise) {
        this.pageCache.delete(pageNumber);
      }
      throw error;
    });
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

  private handleScroll = (): void => {
    if (this.disposed || this.suspended || this.flow !== 'scrolled') {
      return;
    }
    const restoring = this.activeRestore !== null;
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
      if (!restoring) this.callbacks.onPageChange(page);
    }
    if (!restoring) this.callbacks.onScroll(scrollTop, this.currentPage);
    // 滚动位置变化时只调度附近占位页;占位布局本身无需重建。
    void this.relayout();
  };

  private destroyScrolledMode(): void {
    this.destroyScrollObserver();
    for (const state of this.scrolledPages) {
      state.generation += 1;
      state.renderer = null;
      state.element.replaceChildren();
    }
    for (const [pageNumber, renderer] of this.pageRenderers) {
      this.releasePageRenderer(pageNumber, renderer);
    }
    this.scrolledPages = [];
    this.scrollLoadingCount = 0;
    this.pendingScrollAnchor = null;
    this.pages.replaceChildren();
  }

  /** 活动视图切换时只保留当前页，避免隐藏 PDF 长期占用整套 Canvas。 */
  private shrinkToSuspendedWindow(): void {
    const keepPage = Math.min(Math.max(1, this.currentPage), this.pageCount);
    for (const [pageNumber, renderer] of this.pageRenderers) {
      if (pageNumber !== keepPage) {
        this.releasePageRenderer(pageNumber, renderer);
      }
    }
    for (const [pageNumber, pagePromise] of this.pageCache) {
      if (pageNumber === keepPage) continue;
      this.pageCache.delete(pageNumber);
      void pagePromise.then((page) => page.cleanup()).catch(() => undefined);
    }
    for (const pageNumber of this.paginatedRenders.keys()) {
      if (pageNumber !== keepPage) this.paginatedRenders.delete(pageNumber);
    }
    for (const pageNumber of this.scrolledRenders.keys()) {
      if (pageNumber !== keepPage) this.scrolledRenders.delete(pageNumber);
    }
    for (const state of this.scrolledPages) {
      if (state.pageNumber === keepPage) {
        if (state.state === 'loading') {
          // detach 可能发生在目标页 getPage/render 尚未完成时。旧任务随后会因
          // suspended/generation 失效退出；若继续保留 loading，回切调度器既
          // 不会重新读取也不会重新渲染该页，最终只剩第一页附近的旧 Canvas。
          state.generation += 1;
          if (state.renderer) {
            this.releasePageRenderer(state.pageNumber, state.renderer);
          }
          this.scrolledRenders.delete(state.pageNumber);
          state.page = null;
          state.renderer = null;
          state.state = 'idle';
          state.element.replaceChildren();
        }
        continue;
      }
      state.generation += 1;
      state.page = null;
      state.renderer = null;
      state.state = 'idle';
      state.element.replaceChildren();
    }
  }

  private attachObservers(): void {
    this.resizeObserver?.disconnect();
    const observerGeneration = ++this.observerGeneration;
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.isCurrentObserver(observerGeneration)) return;
      this.invalidateLayout();
      void this.relayout();
    });
    this.resizeObserver.observe(this.container);
    this.container.removeEventListener('scroll', this.handleScroll);
    this.container.addEventListener('scroll', this.handleScroll, { passive: true });
  }

  private detachObservers(): void {
    this.observerGeneration += 1;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.container.removeEventListener('scroll', this.handleScroll);
    this.destroyScrollObserver();
  }

  dispose(): void {
    this.disposed = true;
    this.layoutGeneration += 1;
    this.restoreGeneration += 1;
    this.activeRestore = null;
    this.detachObservers();
    for (const state of this.scrolledPages) {
      state.generation += 1;
    }
    for (const renderer of this.pageRenderers.values()) {
      renderer.release();
    }
    this.pageRenderers.clear();
    this.paginatedRenders.clear();
    this.scrolledRenders.clear();
    this.scrolledPages = [];
    this.scrollLoadingCount = 0;
    this.pendingScrollAnchor = null;
    this.layoutWidth = 0;
    for (const promise of this.pageCache.values()) {
      void promise.then((page) => page.cleanup()).catch(() => undefined);
    }
    this.pageCache.clear();
    this.layouts = [];
    this.pages.remove();
  }
}
