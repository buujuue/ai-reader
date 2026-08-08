import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfBookDocument } from './pdfBookDocument';
import { makeFakeDocument, makeFakeLib, makeFakeRasterizer } from './pdfTestFakes';

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
});