import type { AreaSelection, BookDocument, BookDocumentMetadata } from '../bookDocument';
import type { ReadingLocation } from '../readingLocation';
import type { SearchEvent, SearchOptions } from '../search';
import type { Toc, TocItem } from '../toc';
import type { ReadingTypography } from '../typography';
import { THEME_PALETTES } from '../typography';
import type {
  PdfDocumentProxy,
  PdfJsLib,
  PdfOutlineItem,
} from './pdfLibrary';
import { loadPdfLib } from './pdfLibrary';
import type { PdfPageRasterizer } from './pdfPageRenderer';
import { PdfRenderer } from './pdfRenderer';
import { searchPdf } from './pdfSearch';
import {
  decodePdfTextAnchor,
  encodePdfTextAnchor,
  normalizeRectFromRangeRect,
  type PdfHighlight,
  type PdfNormalizedRect,
} from './pdfTextAnchor';

export interface PdfBookDocumentOptions {
  /** PDF 字节内容。 */
  bytes: Uint8Array;
  /** 来源元数据(经 PdfInspector 提取)。 */
  metadata: BookDocumentMetadata;
  /** 可注入的 PDF.js 库(测试用);缺省懒加载真实引擎。 */
  pdfLib?: PdfJsLib | undefined;
  /** 页面光栅化函数(测试注入伪实现,生产用 PDF.js page.render)。 */
  rasterize?: PdfPageRasterizer | undefined;
}

/** 把 PDF.js 目录条目转成 TocItem;href 承载 dest 的 JSON,供 goToHref 解析。 */
function outlineToToc(items: PdfOutlineItem[] | null): Toc {
  if (!items) {
    return [];
  }
  return items.map((item): TocItem => ({
    label: item.title ?? '',
    href: item.dest ? JSON.stringify(item.dest) : '',
    subitems: item.items ? outlineToToc(item.items) : null,
  }));
}

/**
 * PDF 的 BookDocument 实现。它把 PDF.js 文档代理、范围读取、页面渲染与文本层
 * 统一封装在窄接口之后;上层只通过 BookDocument 与 ReadingLocation 交互,
 * 不直接操纵 PDF.js 对象或页面 DOM。
 *
 * 安全边界(ADR-0010):`isEvalSupported` 关闭;渲染只输出 Canvas 与文本层 DOM,
 * 不执行书内脚本;范围读取带并发上限(MAX_CONCURRENT_RANGES)。
 *
 * 内存预算:渲染窗口只保留视口附近的已光栅化画布,离开窗口即释放位图;
 * 解码页面按 LRU 缓存并 `cleanup()` 回收;缩放/卸载时取消过期渲染任务。
 */
export class PdfBookDocument implements BookDocument {
  readonly format = 'pdf' as const;
  readonly metadata: BookDocumentMetadata;

  private readonly bytes: Uint8Array;
  private readonly pdfLib: PdfJsLib | undefined;
  private readonly rasterize: PdfPageRasterizer | undefined;

  private pdf: PdfDocumentProxy | null = null;
  private renderer: PdfRenderer | null = null;
  private container: HTMLElement | null = null;
  private typography: ReadingTypography;
  private currentLocation: PdfReadingLocationLike | null = null;
  private locationListeners = new Set<(location: ReadingLocation) => void>();
  private toc: Toc | null = null;
  /** 已绘制的高亮批注(按锚点值 → 页码 + 归一化矩形)。 */
  private annotationHighlights = new Map<string, { page: number; rect: PdfHighlight['rect']; color: string }>();
  /** 搜索命中高亮(按页码聚合)。 */
  private searchHighlights = new Map<number, PdfHighlight[]>();
  /** 高亮覆盖层点击监听器。 */
  private showAnnotationListeners = new Set<(value: string) => void>();
  /** 扫描页区域选择监听器,仅持有当前手势事件不进入持久化状态。 */
  private areaSelectionListeners = new Set<(selection: AreaSelection) => void>();

  constructor(options: PdfBookDocumentOptions) {
    this.bytes = options.bytes;
    this.metadata = options.metadata;
    this.pdfLib = options.pdfLib;
    this.rasterize = options.rasterize;
    this.typography = {
      fontFamily: 'sansSerif',
      fontSize: 18,
      lineHeight: 1.6,
      margin: 48,
      gap: 7,
      flow: 'paginated',
      theme: 'light',
    };
  }

  async open(container: HTMLElement): Promise<void> {
    if (this.pdf) {
      throw new Error('该 BookDocument 已打开');
    }
    this.container = container;

    const lib = this.pdfLib ?? (await loadPdfLib());
    // 用 `data` 直接交给 PDF.js(与 inspectPdf 一致)。这里已持有完整字节,无需范围读取;
    // 且 `getDocument({ data })` 会把 ArrayBuffer 转移给 worker,若紧跟在前一次
    // `getDocument({ data })` 之后用 `getDocument({ range })`,pdfjs 模块级 worker 状态
    // 会让范围传输读到空文件。复制一份字节再给 `data`,避免脱离本实例持有的 buffer。
    const document = await lib
      .getDocument({ data: this.bytes.slice(), isEvalSupported: false })
      .promise;
    this.pdf = document;

    await this.readMetadata(document);

    const renderer = new PdfRenderer(
      {
        document,
        container,
        lib,
        rasterize: this.rasterize,
        devicePixelRatio: () => window.devicePixelRatio || 1,
      },
      {
        onPageChange: (page) => this.handlePageChange(page),
        onScroll: (scrollTop, page) => this.handleScroll(scrollTop, page),
        onPageRendered: (page) => this.redrawPage(page),
        onAreaSelection: (selection) => this.notifyAreaSelection(selection),
      },
    );
    this.renderer = renderer;
    renderer.setFlow(this.typography.flow);
    renderer.setViewport(
      this.currentLocation?.zoom ?? 100,
      this.currentLocation?.fit ?? 'width',
    );
    this.applyTheme(this.typography.theme);
    await renderer.mount();
    this.wireHighlightClick();
  }

  getLocation(): ReadingLocation | null {
    return this.currentLocation;
  }

  getTOC(): Toc {
    return this.toc ?? [];
  }

  async goToHref(href: string): Promise<void> {
    if (!this.pdf) {
      return;
    }
    const pageIndex = await this.resolveHrefToPage(href);
    if (pageIndex !== null) {
      await this.goToPage(pageIndex + 1);
    }
  }

  async next(): Promise<void> {
    if (!this.renderer) {
      return;
    }
    if (this.typography.flow === 'paginated') {
      await this.renderer.goToPage(this.renderer.getCurrentPage() + 1);
      this.notifyLocation();
    } else if (this.container) {
      const container = this.container;
      this.renderer.setScrollTop(container.scrollTop + container.clientHeight);
    }
  }

  async prev(): Promise<void> {
    if (!this.renderer) {
      return;
    }
    if (this.typography.flow === 'paginated') {
      await this.renderer.goToPage(this.renderer.getCurrentPage() - 1);
      this.notifyLocation();
    } else if (this.container) {
      const container = this.container;
      this.renderer.setScrollTop(Math.max(0, container.scrollTop - container.clientHeight));
    }
  }

  async goToLocation(location: ReadingLocation): Promise<void> {
    if (location.kind !== 'pdf') {
      return;
    }
    this.currentLocation = {
      kind: 'pdf',
      page: location.page,
      scrollTop: location.scrollTop,
      zoom: location.zoom,
      fit: location.fit,
    };
    this.renderer?.setViewport(location.zoom, location.fit);
    if (this.typography.flow === 'paginated') {
      await this.renderer?.goToPage(location.page);
    } else {
      await this.renderer?.goToPage(location.page);
      this.renderer?.setScrollTop(location.scrollTop);
    }
    this.notifyLocation();
  }

  /** 调整 PDF 视口(缩放与页面适配模式),并同步当前阅读位置。 */
  setViewport(zoom: number, fit: PdfFitModeLike): void {
    this.renderer?.setViewport(zoom, fit);
    if (this.currentLocation) {
      this.currentLocation = { ...this.currentLocation, zoom, fit };
    }
    this.notifyLocation();
  }

  /**
   * 跳到某 PDF 文本锚点:分页模式转到对应页;滚动模式额外滚动到命中矩形,
   * 使搜索结果/批注跳转落到正文对应位置而非页顶。
   */
  async goToPdfAnchor(value: string): Promise<void> {
    const loc = decodePdfTextAnchor(value);
    if (!loc || !this.renderer) {
      return;
    }
    const current = this.currentLocation;
    const zoom = current?.zoom ?? this.renderer.getViewportState().zoom;
    const fit = current?.fit ?? this.renderer.getViewportState().fit;
    this.goToLocationBase(loc.page, 0, zoom, fit);
    await this.renderer.goToPage(loc.page);
    if (this.typography.flow !== 'paginated' && this.container) {
      // 滚动模式:把命中矩形顶部滚动到容器顶部附近(留出少量边距)。
      const pageRenderer = this.renderer.getPageRenderer(loc.page);
      const pageElement = pageRenderer?.element;
      if (pageElement) {
        const pageTop = pageElement.offsetTop;
        const target = pageTop + loc.rect.y * pageElement.offsetHeight - 24;
        this.renderer.setScrollTop(Math.max(0, target));
      }
    }
    this.notifyLocation();
  }

  /** 写入阅读位置而不触发渲染(供 goToPdfAnchor 组合使用)。 */
  private goToLocationBase(page: number, scrollTop: number, zoom: number, fit: PdfFitModeLike): void {
    this.currentLocation = { kind: 'pdf', page, scrollTop, zoom, fit };
  }

  search(options: SearchOptions): AsyncGenerator<SearchEvent, void, void> {
    if (!this.pdf) {
      return (async function* searchNoDoc() {})();
    }
    return this.searchWithHighlights(options);
  }

  /** 搜索并边产出边把命中画到对应页(命中矩形即锚点矩形)。 */
  private async *searchWithHighlights(options: SearchOptions): AsyncGenerator<SearchEvent, void, void> {
    if (!this.pdf) {
      return;
    }
    for await (const event of searchPdf(this.pdf, options)) {
      if (event.kind === 'match') {
        const loc = decodePdfTextAnchor(event.match.cfi);
        if (loc) {
          const existing = this.searchHighlights.get(loc.page) ?? [];
          existing.push({ rect: loc.rect, color: '#2196f3' });
          this.searchHighlights.set(loc.page, existing);
          this.redrawPage(loc.page);
        }
      }
      yield event;
    }
  }

  clearSearch(): void {
    this.searchHighlights.clear();
    this.redrawHighlights();
  }

  applyTypography(settings: ReadingTypography): void {
    const flowChanged = settings.flow !== this.typography.flow;
    const themeChanged = settings.theme !== this.typography.theme;
    this.typography = settings;
    this.renderer?.setFlow(settings.flow);
    if (themeChanged) {
      this.applyTheme(settings.theme);
    }
    if (flowChanged && this.renderer) {
      // 模式切换后按当前页码重新定位。
      void this.renderer.goToPage(this.renderer.getCurrentPage());
    }
  }

  getCFI(_index: number, range: Range): string {
    // 把选区 Range 换算成「选区所属页码 + 归一化矩形」的 PDF 文本锚点。
    const location = this.rangeToPdfLocation(range);
    if (!location) {
      return '';
    }
    return encodePdfTextAnchor(location);
  }

  getAreaAnchor(selection: AreaSelection): string {
    if (!Number.isInteger(selection.page) || selection.page < 1) {
      return '';
    }
    return encodePdfTextAnchor({ page: selection.page, rect: selection.rect });
  }

  getCurrentIndex(): number | null {
    return this.renderer?.getCurrentPage() ?? null;
  }

  addAnnotation(annotation: { value: string; color: string }): void {
    const loc = decodePdfTextAnchor(annotation.value);
    if (!loc) {
      return;
    }
    this.annotationHighlights.set(annotation.value, {
      page: loc.page,
      rect: loc.rect,
      color: annotation.color,
    });
    this.redrawHighlights();
  }

  removeAnnotation(value: string): void {
    if (!this.annotationHighlights.delete(value)) {
      return;
    }
    this.redrawHighlights();
  }

  onShowAnnotation(listener: (value: string) => void): () => void {
    this.showAnnotationListeners.add(listener);
    return () => this.showAnnotationListeners.delete(listener);
  }

  onAreaSelection(listener: (selection: AreaSelection) => void): () => void {
    this.areaSelectionListeners.add(listener);
    return () => this.areaSelectionListeners.delete(listener);
  }

  onInternalLink(): () => void {
    return () => undefined;
  }

  onExternalLink(): () => void {
    return () => undefined;
  }

  getContentDocs(): readonly Document[] {
    return this.container && this.container.ownerDocument
      ? [this.container.ownerDocument]
      : [];
  }

  onContentCreate(listener: (doc: Document) => void): () => void {
    if (this.container && this.container.ownerDocument) {
      listener(this.container.ownerDocument);
    }
    return () => undefined;
  }

  onLocationChange(listener: (location: ReadingLocation) => void): () => void {
    this.locationListeners.add(listener);
    return () => this.locationListeners.delete(listener);
  }

  /** 渲染首页为封面图像(Blob)。扫描 PDF 同样适用(直接输出首页位图)。 */
  async getCover(): Promise<Blob | null> {
    if (!this.pdf) {
      return null;
    }
    try {
      const page = await this.pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) {
        return null;
      }
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((result) => resolve(result), 'image/png'),
      );
      canvas.width = 0;
      canvas.height = 0;
      return blob;
    } catch {
      return null;
    }
  }

  close(): void {
    this.renderer?.dispose();
    this.renderer = null;
    if (this.pdf) {
      void this.pdf.destroy().catch(() => undefined);
      this.pdf = null;
    }
    this.container?.removeEventListener('click', this.handleContainerClick);
    this.container = null;
    this.currentLocation = null;
    this.locationListeners.clear();
    this.showAnnotationListeners.clear();
    this.areaSelectionListeners.clear();
    this.annotationHighlights.clear();
    this.searchHighlights.clear();
    this.toc = null;
  }

  // ---- 内部 ----

  /** 找到 Range 所在页面,避免滚动模式下误用当前页码。 */
  private pageRendererForRange(range: Range) {
    const container = range.commonAncestorContainer;
    const element =
      container.nodeType === Node.ELEMENT_NODE
        ? (container as Element)
        : container.parentElement;
    const pageElement = element?.closest('.pdf-page') as HTMLElement | null;
    const pageNumber = Number(pageElement?.dataset.page ?? 0);
    if (pageNumber > 0) {
      return { pageNumber, renderer: this.renderer?.getPageRenderer(pageNumber) ?? null };
    }
    const currentPage = this.currentPageNumber();
    return {
      pageNumber: currentPage,
      renderer: this.renderer?.getPageRenderer(currentPage) ?? null,
    };
  }

  /** 把选区 Range 的显示矩形换算成页面内归一化矩形(用于构建文本锚点)。 */
  private rangeToPdfLocation(range: Range): { page: number; rect: PdfNormalizedRect } | null {
    const { pageNumber, renderer } = this.pageRendererForRange(range);
    const pageElement = renderer?.element;
    if (!pageElement) {
      return null;
    }
    const rangeRect = range.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    const rect = normalizeRectFromRangeRect(rangeRect, pageRect);
    return rect ? { page: pageNumber, rect } : null;
  }

  /** 当前页码(优先已记录位置,其次渲染器)。 */
  private currentPageNumber(): number {
    return this.currentLocation?.page ?? this.renderer?.getCurrentPage() ?? 1;
  }

  /** 把某页的批注 + 搜索高亮合并后交给渲染器绘制。 */
  private redrawPage(page: number): void {
    const highlights: PdfHighlight[] = [];
    for (const annotation of this.annotationHighlights.values()) {
      if (annotation.page === page) {
        highlights.push({ rect: annotation.rect, color: annotation.color });
      }
    }
    const search = this.searchHighlights.get(page);
    if (search) {
      highlights.push(...search);
    }
    this.renderer?.setPageHighlights(page, highlights);
  }

  /** 重绘全部已挂载页面的高亮(批注 + 搜索)。 */
  private redrawHighlights(): void {
    if (!this.renderer) {
      return;
    }
    const pages = new Set<number>();
    for (const annotation of this.annotationHighlights.values()) {
      pages.add(annotation.page);
    }
    for (const page of this.searchHighlights.keys()) {
      pages.add(page);
    }
    // 始终重绘当前页,确保移除最后一条批注/清空搜索后覆盖层被清除。
    pages.add(this.renderer.getCurrentPage());
    for (const page of pages) {
      this.redrawPage(page);
    }
  }

  /** 接线容器点击:命中高亮矩形时按锚点值通知订阅者(打开笔记编辑器)。 */
  private wireHighlightClick(): void {
    this.container?.addEventListener('click', this.handleContainerClick);
  }

  private notifyAreaSelection(selection: AreaSelection): void {
    for (const listener of this.areaSelectionListeners) {
      listener(selection);
    }
  }

  private handleContainerClick = (event: MouseEvent): void => {
    if (this.showAnnotationListeners.size === 0 || !this.container) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const targetPage = target?.closest<HTMLElement>('.pdf-page');
    const targetPageNumber = Number(targetPage?.dataset.page ?? 0);
    const pageNumber = targetPageNumber > 0 ? targetPageNumber : this.currentPageNumber();
    const renderer = this.renderer?.getPageRenderer(pageNumber);
    const pageElement = renderer?.element;
    if (!pageElement) {
      return;
    }
    const pageRect = pageElement.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
      return;
    }
    const x = (event.clientX - pageRect.left) / pageRect.width;
    const y = (event.clientY - pageRect.top) / pageRect.height;
    for (const [value, annotation] of this.annotationHighlights) {
      if (annotation.page !== pageNumber) {
        continue;
      }
      const r = annotation.rect;
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
        for (const listener of this.showAnnotationListeners) {
          listener(value);
        }
        return;
      }
    }
  };

  private async readMetadata(document: PdfDocumentProxy): Promise<void> {
    const { info, metadata } = await document.getMetadata();
    const title =
      metadata?.get('dc:title') ?? (typeof info?.Title === 'string' ? info.Title : null);
    const outline = await document.getOutline();
    this.toc = outlineToToc(outline);
    // metadata 已由构造时提供;此处仅确保目录就绪。
    void title;
  }

  private handlePageChange(page: number): void {
    const base = this.currentLocation ?? {
      scrollTop: this.typography.flow === 'paginated' ? 0 : this.container?.scrollTop ?? 0,
      zoom: this.renderer?.getViewportState().zoom ?? 100,
      fit: (this.renderer?.getViewportState().fit ?? 'width') as PdfFitModeLike,
    };
    this.currentLocation = {
      kind: 'pdf',
      page,
      scrollTop: this.typography.flow === 'paginated' ? 0 : base.scrollTop,
      zoom: base.zoom,
      fit: base.fit,
    };
    this.notifyLocation();
    this.redrawPage(page);
  }

  private handleScroll(scrollTop: number, page: number): void {
    const base = this.currentLocation ?? {
      zoom: this.renderer?.getViewportState().zoom ?? 100,
      fit: (this.renderer?.getViewportState().fit ?? 'width') as PdfFitModeLike,
    };
    this.currentLocation = {
      kind: 'pdf',
      page,
      scrollTop,
      zoom: base.zoom,
      fit: base.fit,
    };
    this.notifyLocation();
  }

  private notifyLocation(): void {
    if (!this.currentLocation) {
      return;
    }
    const location = this.currentLocation;
    for (const listener of this.locationListeners) {
      listener(location);
    }
  }

  private async resolveHrefToPage(href: string): Promise<number | null> {
    if (!this.pdf) {
      return null;
    }
    try {
      let dest: unknown;
      try {
        dest = JSON.parse(href);
      } catch {
        dest = undefined;
      }
      if (dest === undefined || typeof dest === 'string') {
        dest = href.length > 0 ? await this.pdf.getDestination(href) : null;
      }
      if (Array.isArray(dest) && dest[0]) {
        return this.pdf.getPageIndex(dest[0]);
      }
      return null;
    } catch {
      return null;
    }
  }

  private async goToPage(page: number): Promise<void> {
    await this.renderer?.goToPage(page);
    this.notifyLocation();
  }

  private applyTheme(theme: ReadingTypography['theme']): void {
    if (!this.container) {
      return;
    }
    const palette = THEME_PALETTES[theme];
    this.container.style.backgroundColor = palette.background;
    this.container.style.color = palette.foreground;
  }
}

/** PDF 阅读位置的精简内部形状(避免与 readingLocation 的联合类型耦合混淆)。 */
interface PdfReadingLocationLike {
  kind: 'pdf';
  page: number;
  scrollTop: number;
  zoom: number;
  fit: PdfFitModeLike;
}

type PdfFitModeLike = 'width' | 'height' | 'page' | 'actual';
