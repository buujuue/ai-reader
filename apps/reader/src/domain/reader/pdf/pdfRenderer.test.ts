import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfRenderer } from './pdfRenderer';
import { makeFakeDocument, makeFakeLib, makeFakeRasterizer } from './pdfTestFakes';

function makeContainer(): HTMLElement {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
  return container;
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
});

describe('PdfRenderer 分页模式', () => {
  it('挂载后渲染当前页,goToPage 切换页面并上报页码', async () => {
    const document = makeFakeDocument(5);
    const callbacks = { onPageChange: vi.fn(), onScroll: vi.fn() };
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), rasterize: makeFakeRasterizer(), devicePixelRatio: () => 1 },
      callbacks,
    );
    await renderer.mount();
    expect(renderer.getCurrentPage()).toBe(1);

    await renderer.goToPage(3);
    expect(renderer.getCurrentPage()).toBe(3);
    expect(callbacks.onPageChange).toHaveBeenCalledWith(3);
  });

  it('分页模式页面越界被夹紧到合法区间', async () => {
    const document = makeFakeDocument(5);
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    await renderer.mount();
    await renderer.goToPage(999);
    expect(renderer.getCurrentPage()).toBe(5);
    await renderer.goToPage(0);
    expect(renderer.getCurrentPage()).toBe(1);
  });

  it('分页模式只保留当前页的渲染器,替换页面释放旧位图(内存预算)', async () => {
    const document = makeFakeDocument(10);
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    await renderer.mount();

    expect(mountedPageCount(renderer)).toBe(1);
    await renderer.goToPage(6);
    expect(mountedPageCount(renderer)).toBe(1);
  });
});

describe('PdfRenderer 滚动模式', () => {
  it('滚动后按各页布局位置确定当前页码', async () => {
    const document = makeFakeDocument(8);
    const scrollEvent = vi.fn();
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: scrollEvent },
    );
    renderer.setFlow('scrolled');
    await renderer.mount();

    // 滚到底部:当前页应为最后一页。
    renderer.setScrollTop(1_000_000);
    expect(renderer.getCurrentPage()).toBe(8);
    expect(scrollEvent).toHaveBeenCalled();
  });

  it('滚动模式只挂载视口附近的页面,离开窗口的页面被释放(内存预算)', async () => {
    const document = makeFakeDocument(30);
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');
    await renderer.mount();

    // 初始(顶部)只挂载一部分页面,而非全部 30 页。
    expect(mountedPageCount(renderer)).toBeLessThan(30);
    expect(mountedPageCount(renderer)).toBeGreaterThan(0);
  });

  it('视口变化后按新的缩放与适配模式重建页面布局', async () => {
    const document = makeFakeDocument(3);
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');
    await renderer.mount();
    await renderer.relayout();

    expect(renderer.getPageRenderer(2)?.element.style.height).not.toBe('1684px');
    renderer.setViewport(200, 'actual');
    await renderer.goToPage(2);

    await vi.waitFor(() => {
      expect(renderer.getPageRenderer(2)?.element.style.height).toBe('1684px');
    });
    renderer.dispose();
  });

  it('容器宽度变化后重建滚动页面的尺寸与偏移', async () => {
    const document = makeFakeDocument(3);
    const container = makeContainer();
    const renderer = new PdfRenderer(
      { document, container, lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');
    await renderer.mount();
    await renderer.relayout();
    expect(parseFloat(renderer.getPageRenderer(2)?.element.style.width ?? '0')).toBeCloseTo(800);

    Object.defineProperty(container, 'clientWidth', { value: 600, configurable: true });
    await renderer.relayout();

    expect(parseFloat(renderer.getPageRenderer(2)?.element.style.width ?? '0')).toBeCloseTo(600);
    renderer.dispose();
  });
});

describe('PdfRenderer 视口状态', () => {
  it('setViewport 更新缩放与适配模式,getViewportState 反映当前状态', async () => {
    const document = makeFakeDocument(3);
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    await renderer.mount();

    expect(renderer.getViewportState()).toEqual({ zoom: 100, fit: 'width' });
    renderer.setViewport(150, 'page');
    expect(renderer.getViewportState()).toEqual({ zoom: 150, fit: 'page' });
  });
});

/** 统计容器内已挂载的页面元素数(所有页面渲染器都挂载到容器的 pages 节点下)。 */
function mountedPageCount(renderer: PdfRenderer): number {
  const container = (renderer as unknown as { container: HTMLElement }).container;
  return container.querySelectorAll('.pdf-page').length;
}