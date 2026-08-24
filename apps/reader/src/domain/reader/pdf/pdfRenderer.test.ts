import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfRenderer } from './pdfRenderer';
import type { PdfDocumentProxy, PdfPage } from './pdfLibrary';
import {
  makeFakeDocument,
  makeFakeLib,
  makeFakePage,
  makeFakeRasterizer,
  makeFakeRenderTask,
} from './pdfTestFakes';

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
  it('当前页完成后会提前取得并预渲染下一页', async () => {
    const document = makeFakeDocument(3) as PdfDocumentProxy & { pages: PdfPage[] };
    const renderedPages: PdfPage[] = [];
    const container = makeContainer();
    const renderer = new PdfRenderer(
      {
        document,
        container,
        lib: makeFakeLib(document),
        rasterize: makeFakeRasterizer((page) => renderedPages.push(page)),
        devicePixelRatio: () => 1,
      },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );

    await renderer.mount();

    await vi.waitFor(() => {
      expect(document.getPage).toHaveBeenCalledWith(2);
      expect(renderedPages).toContain(document.pages[1]);
      expect(renderer.getPageRenderer(2)?.getBitmapArea()).toBeGreaterThan(0);
    });
    expect(mountedPageCount(renderer)).toBe(1);

    const secondPageRenderCountBeforeTurn = renderedPages.filter(
      (page) => page === document.pages[1],
    ).length;
    await renderer.goToPage(2);
    expect(renderedPages.filter((page) => page === document.pages[1])).toHaveLength(
      secondPageRenderCountBeforeTurn,
    );
    expect(renderer.getCurrentPage()).toBe(2);
    renderer.dispose();
  });

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

  it('并发重排时旧页的异步结果不会覆盖当前页内容', async () => {
    const page1 = makeFakePage({ width: 595, height: 842 });
    const page2 = makeFakePage({ width: 595, height: 842 });
    let page1ReadCount = 0;
    let releaseStalePage: () => void = () => undefined;
    const stalePageGate = new Promise<void>((resolve) => {
      releaseStalePage = resolve;
    });
    const document = makeFakeDocument(2);
    (document.getPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (pageNumber: number) => {
        if (pageNumber === 1 && page1ReadCount++ === 1) {
          await stalePageGate;
        }
        return pageNumber === 1 ? page1 : page2;
      },
    );
    const container = makeContainer();
    const renderer = new PdfRenderer(
      {
        document,
        container,
        lib: makeFakeLib(document),
        rasterize: (page, canvas) => {
          canvas.dataset.renderedPage = page === page1 ? '1' : '2';
          return makeFakeRenderTask();
        },
        devicePixelRatio: () => 1,
      },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    await renderer.mount();

    // 模拟 ResizeObserver 已经开始重排旧页,随后用户翻到第二页。
    const pageCache = (renderer as unknown as { pageCache: Map<number, Promise<unknown>> }).pageCache;
    pageCache.delete(1);
    const staleRelayout = renderer.relayout();
    await Promise.resolve();
    await renderer.goToPage(2);
    releaseStalePage();
    await staleRelayout;

    expect(renderer.getCurrentPage()).toBe(2);
    expect(container.querySelector<HTMLCanvasElement>('.pdf-page canvas')?.dataset.renderedPage).toBe(
      '2',
    );
    renderer.dispose();
  });
});

describe('PdfRenderer 滚动模式', () => {
  it('600 页以上只为当前位置附近取得页面,其余页面先保留稳定占位', async () => {
    const document = makeFakeDocument(640);
    const container = makeContainer();
    const renderer = new PdfRenderer(
      { document, container, lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');

    await renderer.mount();

    expect(document.getPage).toHaveBeenCalled();
    const getPage = document.getPage as ReturnType<typeof vi.fn>;
    expect(getPage.mock.calls.length).toBeLessThan(20);
    expect(getPage.mock.calls.length).toBeLessThan(document.numPages);
    expect(getPage).not.toHaveBeenCalledWith(640);
    expect(renderer
      .getPageRenderer(640))
      .toBeNull();
    expect(container.querySelectorAll('.pdf-page-placeholder')).toHaveLength(640);
    expect(container.querySelector('.pdf-page[data-page="640"]')).toBeNull();
    renderer.dispose();
  });

  it('滚动模式为每一页建立占位,混合尺寸加载后保持当前页锚点', async () => {
    const document = makeFakeDocument(30, [
      { width: 1200, height: 1600 },
      { width: 400, height: 500 },
      { width: 900, height: 700 },
    ]);
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');

    await renderer.mount();
    renderer.setScrollTop(4_000);
    const pageBeforeLoad = renderer.getCurrentPage();
    await vi.waitFor(() => expect(renderer.getPageRenderer(pageBeforeLoad)).not.toBeNull());

    const scrollBefore = renderer.getScrollTop();
    const getPage = document.getPage as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(getPage.mock.calls.length).toBeGreaterThan(3));

    expect(renderer.getCurrentPage()).toBe(pageBeforeLoad);
    expect(renderer.getScrollTop()).toBeGreaterThanOrEqual(scrollBefore - 1);
    expect(renderer.getScrollTop()).toBeLessThanOrEqual(scrollBefore + 1_000);
    renderer.dispose();
  });

  it('快速滚动按最近页优先且在途页面不超过 3 个', async () => {
    const document = makeFakeDocument(640);
    const pages = (document as unknown as { pages: PdfPage[] }).pages;
    let activeReads = 0;
    let maximumActiveReads = 0;
    (document.getPage as ReturnType<typeof vi.fn>).mockImplementation(async (pageNumber: number) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      return pages[pageNumber - 1]!;
    });
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');

    await renderer.mount();
    renderer.setScrollTop(200 * ((800 / 595) * 842 + 20));
    await vi.waitFor(() => expect(renderer.getCurrentPage()).toBeGreaterThan(190));
    await vi.waitFor(() => expect(renderer.getPageRenderer(renderer.getCurrentPage())).not.toBeNull());

    expect(maximumActiveReads).toBeLessThanOrEqual(3);
    const getPage = document.getPage as ReturnType<typeof vi.fn>;
    expect(getPage).toHaveBeenCalledWith(expect.any(Number));
    expect(getPage.mock.calls.some(([page]) => page >= 195 && page <= 205)).toBe(true);
    expect(getPage.mock.calls.length).toBeLessThan(40);
    renderer.dispose();
  });

  it('连续滚动释放最远不可见页面,当前页保留且渲染器不超过 12 个', async () => {
    const document = makeFakeDocument(80);
    const renderer = new PdfRenderer(
      { document, container: makeContainer(), lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');

    await renderer.mount();
    for (const page of [10, 20, 30, 40, 50, 60]) {
      await renderer.goToPage(page);
      await vi.waitFor(() => expect(renderer.getPageRenderer(page)).not.toBeNull());
    }

    const rendererContainer = (renderer as unknown as { container: HTMLElement }).container;
    expect(rendererContainer.querySelectorAll('.pdf-page').length).toBeLessThanOrEqual(12);
    expect(renderer.getPageRenderer(renderer.getCurrentPage())).not.toBeNull();
    renderer.dispose();
  });

  it('使用 IntersectionObserver 标记预加载窗口,并把可见页面交给最近页优先调度', async () => {
    const observer: {
      observed: Element[];
      options: IntersectionObserverInit;
      trigger: (elements: Element[]) => void;
    } = {
      observed: [],
      options: {},
      trigger: () => undefined,
    };
    vi.stubGlobal(
      'IntersectionObserver',
      class FakeIntersectionObserver {
        readonly observed: Element[] = [];
        readonly options: IntersectionObserverInit;
        constructor(
          private readonly callback: (entries: IntersectionObserverEntry[]) => void,
          options: IntersectionObserverInit,
        ) {
          this.options = options;
          observer.observed = this.observed;
          observer.options = options;
          observer.trigger = (elements: Element[]) => {
            this.callback(
              elements.map((target: Element) => ({
                target,
                isIntersecting: true,
              }) as IntersectionObserverEntry),
            );
          };
        }
        observe(element: Element): void {
          this.observed.push(element);
        }
        disconnect(): void {}
      },
    );

    const document = makeFakeDocument(40);
    const container = makeContainer();
    const renderer = new PdfRenderer(
      { document, container, lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');

    await renderer.mount();
    expect(observer.options.root).toBe(container);
    expect(observer.options.rootMargin).toBe('200% 0px');
    expect(observer.observed).toHaveLength(40);

    await renderer.goToPage(20);
    const page20 = container.querySelector('[data-page="20"]');
    const page21 = container.querySelector('[data-page="21"]');
    expect(page20).not.toBeNull();
    expect(page21).not.toBeNull();
    observer.trigger([page20!, page21!]);
    await vi.waitFor(() => expect(renderer.getPageRenderer(20)).not.toBeNull());
    renderer.dispose();
  });

  it('位置恢复的绝对 scrollTop 不属于目标页时回退到目标页顶端', async () => {
    const document = makeFakeDocument(10);
    const container = makeContainer();
    const renderer = new PdfRenderer(
      { document, container, lib: makeFakeLib(document), devicePixelRatio: () => 1 },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');

    await renderer.mount();
    await renderer.goToPage(5, 0);

    const placeholder = container.querySelector<HTMLElement>('[data-page="5"]');
    const pageTop = Number.parseFloat(placeholder?.style.top ?? 'NaN');
    expect(renderer.getCurrentPage()).toBe(5);
    expect(renderer.getScrollTop()).toBe(pageTop);

    await renderer.goToPage(5, pageTop + 100);
    expect(renderer.getScrollTop()).toBe(pageTop + 100);
    renderer.dispose();
  });

  it('初始布局会预渲染当前页与下一页,原生滚动事件也会重排窗口', async () => {
    const document = makeFakeDocument(30);
    const pages = (document as unknown as { pages: PdfPage[] }).pages;
    const renderedPages: PdfPage[] = [];
    const container = makeContainer();
    const renderer = new PdfRenderer(
      {
        document,
        container,
        lib: makeFakeLib(document),
        rasterize: makeFakeRasterizer((page) => renderedPages.push(page)),
        devicePixelRatio: () => 1,
      },
      { onPageChange: vi.fn(), onScroll: vi.fn() },
    );
    renderer.setFlow('scrolled');
    await renderer.mount();

    expect(container.querySelector('[data-page="2"]')).not.toBeNull();
    expect(renderer.getPageRenderer(2)?.getBitmapArea()).toBeGreaterThan(0);
    const secondPageRenderCountBeforeScroll = renderedPages.filter(
      (page) => page === pages[1],
    ).length;

    // 模拟用户直接拖动/滚轮滚动容器;这条路径不能依赖目录点击或 setScrollTop。
    container.scrollTop = 1_200;
    container.dispatchEvent(new Event('scroll'));

    await vi.waitFor(() => {
      expect(renderer.getCurrentPage()).toBe(2);
      expect(container.querySelector('[data-page="2"]')).not.toBeNull();
      expect(container.querySelector('[data-page="3"]')).not.toBeNull();
    });
    expect(renderedPages.filter(
      (page) => page === pages[1],
    )).toHaveLength(secondPageRenderCountBeforeScroll);
    renderer.dispose();
  });

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
