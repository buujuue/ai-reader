import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfBookDocument } from './pdfBookDocument';
import { createPdfSourceFromBytes } from './pdfLibrary';
import { ManagedFileSource } from '../../library/managedFileSource';
import { makeFakeDocument, makeFakeLib, makeFakePage, makeFakeRasterizer } from './pdfTestFakes';
import { decodePdfTextAnchor } from './pdfTextAnchor';

function makeContainer(): HTMLElement {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  return container;
}

function createDocument(overrides: { pageCount?: number } = {}) {
  const document = makeFakeDocument(overrides.pageCount ?? 5);
  const lib = makeFakeLib(document);
  const rasterize = makeFakeRasterizer();
  const book = new PdfBookDocument({
    source: createPdfSourceFromBytes(new Uint8Array([1, 2, 3])),
    metadata: { title: '示例 PDF', author: '示例作者', language: 'zh' },
    pdfLib: lib,
    rasterize,
  });
  return { document, lib, rasterize, book };
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class FakeResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    callback(new Blob(['cover'], { type: 'image/png' }));
    return undefined;
  });
});

describe('PdfBookDocument', () => {
  it('打开文档后通过范围传输并发上限读取并挂载渲染器', async () => {
    const { book, lib } = createDocument();
    const container = makeContainer();
    await book.open(container);

    expect(lib.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        isEvalSupported: false,
        wasmUrl: expect.stringMatching(/pdfjs\/wasm\/$/),
        disableStream: true,
        disableAutoFetch: true,
        range: expect.objectContaining({ requestDataRange: expect.any(Function) }),
      }),
    );
    expect((lib.getDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty('data');
    expect(book.getLocation()).toBeNull();
  });

  it('挂起只保留当前页资源,重新挂载复用同一个 PDF.js 文档', async () => {
    const { book, lib, document } = createDocument({ pageCount: 8 });
    const firstContainer = makeContainer();
    await book.open(firstContainer);
    await book.goToLocation({ kind: 'pdf', page: 4, scrollTop: 0, zoom: 125, fit: 'page' });

    const preservedPage = firstContainer.querySelector('.pdf-page');
    await book.detach();

    expect(book.getContentDocs()).toEqual([]);
    expect(book.getLocation()).toEqual({
      kind: 'pdf',
      page: 4,
      scrollTop: 0,
      zoom: 125,
      fit: 'page',
    });
    expect(book.getRuntimeResourceUsage()).toMatchObject({
      canvasCount: 1,
      decodedPageCount: 1,
      inFlightRangeReadCount: 0,
    });

    const secondContainer = makeContainer();
    expect(book.attach(secondContainer)).toBe(true);
    expect(book.consumeRuntimeAttachSnapshot()).toEqual(book.getLocation());
    expect(secondContainer.querySelector('.pdf-page')).toBe(preservedPage);
    await book.goToLocation({ kind: 'pdf', page: 4, scrollTop: 0, zoom: 125, fit: 'page' });
    expect(lib.getDocument).toHaveBeenCalledTimes(1);
    expect(document.destroy).not.toHaveBeenCalled();
    expect(secondContainer.querySelector('.pdf-page')).toBeTruthy();
    book.close();
  });

  it('范围读取未在挂起期限内收敛时返回失败并取消传输', async () => {
    const { book } = createDocument();
    await book.open(makeContainer());
    const rangeTransport = book['rangeTransport']!;
    const cancel = vi.spyOn(rangeTransport, 'cancel');
    vi.spyOn(rangeTransport, 'waitForIdle').mockResolvedValue(false);

    await expect(book.detach()).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    book.close();
  });

  it('PDF.js 结构损坏时打开失败会提供简体中文诊断', async () => {
    const { book, lib } = createDocument();
    (lib.getDocument as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      promise: Promise.reject(new Error('Invalid PDF structure')),
    }));

    await expect(book.open(makeContainer())).rejects.toThrow('PDF 文件损坏或结构无效');
  });

  it('首屏渲染失败只作为打开错误上报一次', async () => {
    const document = makeFakeDocument(1);
    const lib = makeFakeLib(document);
    const renderError = new Error('canvas render failed');
    const book = new PdfBookDocument({
      source: createPdfSourceFromBytes(new Uint8Array([1, 2, 3])),
      metadata: { title: '失败 PDF', author: null, language: null },
      pdfLib: lib,
      rasterize: () => ({ promise: Promise.reject(renderError), cancel: vi.fn() }),
    });
    const readError = vi.fn();
    book.onReadError(readError);

    await expect(book.open(makeContainer())).rejects.toThrow('PDF.js 初始化失败');
    expect(readError).not.toHaveBeenCalled();
  });

  it('托管范围读取失败时打开失败会保留请求区间诊断', async () => {
    const pdf = makeFakeDocument(1);
    const lib = makeFakeLib(pdf);
    const source = new ManagedFileSource(
      { name: '失败.pdf', size: 256 * 1024 },
      async () => {
        throw new Error('磁盘读取失败');
      },
    );
    (lib.getDocument as ReturnType<typeof vi.fn>).mockImplementation((options) => {
      options.range.requestDataRange?.(0, 64);
      return { promise: new Promise(() => undefined) };
    });
    const book = new PdfBookDocument({
      source,
      metadata: { title: '失败 PDF', author: null, language: null },
      pdfLib: lib,
      rasterize: makeFakeRasterizer(),
    });

    await expect(book.open(makeContainer())).rejects.toThrow(
      'PDF 范围读取失败（请求区间 [0,64)',
    );
  });

  it('goToLocation 恢复页码与视口状态(缩放/适配),并上报位置', async () => {
    const { book } = createDocument();
    const listener = vi.fn();
    book.onLocationChange(listener);
    await book.open(makeContainer());

    await book.goToLocation({ kind: 'pdf', page: 3, scrollTop: 0, zoom: 150, fit: 'page' });

    expect(book.getLocation()).toEqual({ kind: 'pdf', page: 3, scrollTop: 0, zoom: 150, fit: 'page' });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ page: 3, zoom: 150, fit: 'page' }),
    );
  });

  it('setViewport 更新当前阅读位置里的缩放与适配模式', async () => {
    const { book } = createDocument();
    await book.open(makeContainer());
    await book.goToLocation({ kind: 'pdf', page: 2, scrollTop: 0, zoom: 100, fit: 'width' });

    book.setViewport(120, 'height');

    expect(book.getLocation()).toEqual({ kind: 'pdf', page: 2, scrollTop: 0, zoom: 120, fit: 'height' });
  });

  it('分页模式下 next/prev 切换页码并更新位置', async () => {
    const { book } = createDocument({ pageCount: 5 });
    await book.open(makeContainer());

    await book.next();
    await book.next();
    expect(book.getLocation()).toEqual(expect.objectContaining({ page: 3 }));

    await book.prev();
    expect(book.getLocation()).toEqual(expect.objectContaining({ page: 2 }));
  });

  it('getCover 渲染首页为位图并返回 Blob', async () => {
    const { book, document } = createDocument();
    await book.open(makeContainer());

    const cover = await book.getCover();

    expect(cover).toBeInstanceOf(Blob);
    expect(document.getPage).toHaveBeenCalledWith(1);
  });

  it('close 释放渲染器并清空位置与目录', async () => {
    const { book, document } = createDocument();
    await book.open(makeContainer());
    await book.goToLocation({ kind: 'pdf', page: 2, scrollTop: 0, zoom: 100, fit: 'width' });

    book.close();

    expect(book.getLocation()).toBeNull();
    expect(book.getTOC()).toEqual([]);
    expect(document.destroy).toHaveBeenCalledTimes(1);
  });

  it('search 在带文字层页面产出命中,命中锚点可解码回页码', async () => {
    const page = makeFakePage({ width: 200, height: 300 }, [
      { str: '关键词在正文', transform: [10, 0, 0, 10, 20, 30], width: 50 },
    ]);
    const { document: pdf, book } = createDocument({ pageCount: 1 });
    (pdf.getPage as ReturnType<typeof vi.fn>).mockResolvedValue(page);
    await book.open(makeContainer());

    const matches: string[] = [];
    for await (const event of book.search({ query: '关键词', matchCase: false })) {
      if (event.kind === 'match') matches.push(event.match.cfi);
    }
    expect(matches.length).toBeGreaterThan(0);
    expect(decodePdfTextAnchor(matches[0]!)?.page).toBe(1);
  });

  it('getCurrentIndex 返回当前页码,getCFI 从选区构建 PDF 文本锚点', async () => {
    const { book } = createDocument();
    await book.open(makeContainer());
    await book.goToLocation({ kind: 'pdf', page: 3, scrollTop: 0, zoom: 100, fit: 'width' });

    expect(book.getCurrentIndex()).toBe(3);

    // 构造一个归属页面元素的 Range,getCFI 应返回可解码的锚点。
    const pageEl = book['renderer']?.getPageRenderer(3)?.element;
    const span = document.createElement('span');
    span.textContent = '选中文字';
    pageEl?.appendChild(span);
    // jsdom 无布局,手动给页面元素与 range 提供显示矩形。
    vi.spyOn(pageEl!, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 50, width: 400, height: 600,
      right: 500, bottom: 650, x: 100, y: 50,
      toJSON: () => ({}),
    } as DOMRect);
    const range = document.createRange();
    range.selectNodeContents(span);
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 180, top: 140, width: 80, height: 20,
        right: 260, bottom: 160, x: 180, y: 140,
        toJSON: () => ({}),
      } as DOMRect),
    });
    const cfi = book.getCFI(3, range);
    expect(decodePdfTextAnchor(cfi)?.page).toBe(3);
    span.remove();
  });

  it('文本选区所在页面不是当前页时,锚点仍记录选区所属页码', async () => {
    const { book } = createDocument({ pageCount: 3 });
    await book.open(makeContainer());
    await book.goToLocation({ kind: 'pdf', page: 1, scrollTop: 0, zoom: 100, fit: 'width' });

    const otherPage = book['renderer']?.getPageRenderer(2);
    // 滚动模式下两个页面会同时挂载,模拟选区归属于第二页。
    book.applyTypography({ ...book['typography'], flow: 'scrolled' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    book['renderer']?.setScrollTop(1200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPage = book['renderer']?.getPageRenderer(2)?.element ?? otherPage?.element;
    expect(secondPage).toBeTruthy();
    const span = document.createElement('span');
    span.textContent = '第二页文字';
    secondPage?.appendChild(span);
    vi.spyOn(secondPage!, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      width: 400,
      height: 600,
      right: 500,
      bottom: 650,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect);
    const range = document.createRange();
    range.selectNodeContents(span);
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 180,
        top: 140,
        width: 80,
        height: 20,
        right: 260,
        bottom: 160,
        x: 180,
        y: 140,
        toJSON: () => ({}),
      } as DOMRect),
    });

    expect(decodePdfTextAnchor(book.getCFI(1, range))?.page).toBe(2);
    span.remove();
  });

  it('addAnnotation/removeAnnotation 绘制并清除高亮覆盖层,onShowAnnotation 收到点击', async () => {
    const { book } = createDocument();
    await book.open(makeContainer());
    await book.goToLocation({ kind: 'pdf', page: 2, scrollTop: 0, zoom: 100, fit: 'width' });

    const value = 'pdf-text:2:0.1:0.2:0.5:0.1';
    book.addAnnotation({ value, color: '#ffd54f' });

    const pageRenderer = book['renderer']?.getPageRenderer(2);
    expect(pageRenderer?.element.querySelector('.pdf-highlight')).toBeTruthy();

    const listener = vi.fn();
    book.onShowAnnotation(listener);
    const pageEl = pageRenderer?.element;
    vi.spyOn(pageEl!, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 50, width: 400, height: 600,
      right: 500, bottom: 650, x: 100, y: 50,
      toJSON: () => ({}),
    } as DOMRect);
    const rect = pageEl?.getBoundingClientRect();
    book['handleContainerClick']?.({
      clientX: (rect?.left ?? 0) + 0.15 * (rect?.width ?? 100),
      clientY: (rect?.top ?? 0) + 0.25 * (rect?.height ?? 100),
    } as MouseEvent);
    expect(listener).toHaveBeenCalledWith(value);

    book.removeAnnotation(value);
    expect(pageRenderer?.element.querySelector('.pdf-highlight')).toBeNull();
  });

  it('滚动模式下按点击事件所属页面解析批注,不误用当前页', async () => {
    const { book } = createDocument();
    await book.open(makeContainer());
    book.applyTypography({ ...book['typography'], flow: 'scrolled' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await book.goToLocation({ kind: 'pdf', page: 2, scrollTop: 0, zoom: 100, fit: 'width' });
    book['renderer']?.setScrollTop(1200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const value = 'pdf-text:2:0.1:0.2:0.5:0.1';
    book.addAnnotation({ value, color: '#ffd54f' });
    const pageRenderer = book['renderer']?.getPageRenderer(2);
    expect(pageRenderer).toBeTruthy();

    vi.spyOn(book as unknown as { currentPageNumber: () => number }, 'currentPageNumber')
      .mockReturnValue(1);
    vi.spyOn(pageRenderer!.element, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 50, width: 400, height: 600,
      right: 500, bottom: 650, x: 100, y: 50,
      toJSON: () => ({}),
    } as DOMRect);
    const listener = vi.fn();
    book.onShowAnnotation(listener);

    book['handleContainerClick']?.({
      target: pageRenderer!.element,
      clientX: 100 + 0.15 * 400,
      clientY: 50 + 0.25 * 600,
    } as unknown as MouseEvent);

    expect(listener).toHaveBeenCalledWith(value);
  });

  it('getContentDocs 返回容器所属文档,onContentCreate 立即补发', async () => {
    const { book } = createDocument();
    const container = makeContainer();
    await book.open(container);

    expect(book.getContentDocs()).toContain(container.ownerDocument);
    const listener = vi.fn();
    book.onContentCreate(listener);
    expect(listener).toHaveBeenCalledWith(container.ownerDocument);
  });

  it('goToPdfAnchor 在滚动模式下滚动到命中矩形位置', async () => {
    const { book } = createDocument();
    const container = makeContainer();
    await book.open(container);
    book.applyTypography({ ...book['typography'], flow: 'scrolled' });
    await book.goToLocation({ kind: 'pdf', page: 1, scrollTop: 0, zoom: 100, fit: 'width' });

    const pageRenderer = book['renderer']?.getPageRenderer(1);
    const pageEl = pageRenderer?.element;
    Object.defineProperty(pageEl!, 'offsetTop', { configurable: true, value: 500 });
    Object.defineProperty(pageEl!, 'offsetHeight', { configurable: true, value: 400 });

    const anchor = 'pdf-text:1:0.1:0.25:0.5:0.1';
    await book.goToPdfAnchor(anchor);

    // 目标 = 500 + 0.25*400 - 24 = 576。
    expect(container.scrollTop).toBe(576);
  });

  it('滚动模式重新渲染某页后仍重绘该页高亮', async () => {
    const { book } = createDocument();
    const container = makeContainer();
    await book.open(container);
    book.applyTypography({ ...book['typography'], flow: 'scrolled' });

    const value = 'pdf-text:1:0.2:0.3:0.4:0.1';
    book.addAnnotation({ value, color: '#ffd54f' });

    // 模拟该页重新渲染:渲染器回调 onPageRendered 应重绘高亮。
    const pageRenderer = book['renderer']?.getPageRenderer(1);
    pageRenderer?.setHighlights([]);
    expect(pageRenderer?.element.querySelector('.pdf-highlight')).toBeNull();
    (book['renderer'] as unknown as { callbacks: { onPageRendered?: (p: number) => void } })
      .callbacks.onPageRendered?.(1);
    expect(pageRenderer?.element.querySelector('.pdf-highlight')).toBeTruthy();
  });
});
