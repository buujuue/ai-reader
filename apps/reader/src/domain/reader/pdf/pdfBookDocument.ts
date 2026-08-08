import type { BookDocument, BookDocumentMetadata } from '../bookDocument';
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
import { createConcurrentRangeTransport, type RangeFileLike } from './pdfRangeTransport';
import { PdfRenderer } from './pdfRenderer';

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

/** 把字节数组包装成可范围读取的文件窄接口。 */
function rangeFileFromBytes(bytes: Uint8Array): RangeFileLike {
  return {
    size: bytes.length,
    slice: (begin, end) => ({
      arrayBuffer: async () =>
        bytes.subarray(begin, end).slice().buffer as ArrayBuffer,
    }),
  };
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
    // 范围读取带并发上限,防止大文件解析时请求洪泛平台文件桥接。
    const { transport } = createConcurrentRangeTransport(
      rangeFileFromBytes(this.bytes),
      (size, initial) => new lib.PDFDataRangeTransport(size, initial),
    );
    const document = await lib
      .getDocument({ range: transport, isEvalSupported: false })
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

  search(_options: SearchOptions): AsyncGenerator<SearchEvent, void, void> {
    // PDF 文本选择与搜索属于后续切片(#15);当前返回空生成器。
    return (async function* searchPdf() {})();
  }

  clearSearch(): void {
    // PDF 无搜索高亮(#15 实现)。
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

  getCFI(): string {
    return '';
  }

  getCurrentIndex(): number | null {
    return null;
  }

  addAnnotation(): void {
    // PDF 批注属后续切片(#16)。
  }

  removeAnnotation(): void {
    // PDF 批注属后续切片(#16)。
  }

  onShowAnnotation(): () => void {
    return () => undefined;
  }

  onInternalLink(): () => void {
    return () => undefined;
  }

  onExternalLink(): () => void {
    return () => undefined;
  }

  getContentDocs(): readonly Document[] {
    return [];
  }

  onContentCreate(): () => void {
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
    this.container = null;
    this.currentLocation = null;
    this.locationListeners.clear();
    this.toc = null;
  }

  // ---- 内部 ----

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