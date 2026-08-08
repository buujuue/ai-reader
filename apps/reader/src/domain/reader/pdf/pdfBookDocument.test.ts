import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfBookDocument } from './pdfBookDocument';
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
    bytes: new Uint8Array([1, 2, 3]),
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
      expect.objectContaining({ isEvalSupported: false }),
    );
    expect(book.getLocation()).toBeNull();
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
    const { book } = createDocument();
    await book.open(makeContainer());
    await book.goToLocation({ kind: 'pdf', page: 2, scrollTop: 0, zoom: 100, fit: 'width' });

    book.close();

    expect(book.getLocation()).toBeNull();
    expect(book.getTOC()).toEqual([]);
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