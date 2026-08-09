import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfPageRenderer } from './pdfPageRenderer';
import { computeRenderDpr, MAX_CANVAS_PIXELS, MAX_RENDER_DPR } from './pdfPageRenderer';
import { makeFakePage, makeFakeRenderTask, makePendingRenderTask } from './pdfTestFakes';
import type { PdfPage } from './pdfLibrary';

/** 让 jsdom 的 canvas 返回伪 2d 上下文,以便渲染器走完正常路径并统计位图面积。 */
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );

  const fakeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  vi.stubGlobal('ResizeObserver', fakeObserver);
});

describe('computeRenderDpr 画布 DPR 预算', () => {
  it('真实 DPR 被 MAX_RENDER_DPR 向上夹紧', () => {
    const page = makeFakePage({ width: 100, height: 100 });
    expect(computeRenderDpr(page, 1, 4)).toBe(MAX_RENDER_DPR);
    expect(computeRenderDpr(page, 1, 1)).toBe(1);
  });

  it('超大页面按单页位图预算下调 DPR 且不低于 1', () => {
    const page = makeFakePage({ width: 2000, height: 1500 });
    const dpr = computeRenderDpr(page, 1, 2);
    expect(dpr).toBeGreaterThanOrEqual(1);
    // 被单页位图预算下调,不再沿用真实 DPR 2。
    expect(dpr).toBeLessThan(2);
    // 位图面积不超过硬上限。
    const viewport = page.getViewport({ scale: 1 });
    expect(viewport.width * dpr * viewport.height * dpr).toBeLessThanOrEqual(
      MAX_CANVAS_PIXELS * 1.001,
    );
  });
});

describe('PdfPageRenderer 画布内存预算', () => {
  it('渲染后按画布尺寸统计位图面积,释放后归零', async () => {
    const page = makeFakePage({ width: 200, height: 300 });
    const renderer = new PdfPageRenderer(1, () => makeFakeRenderTask());
    void renderer.render(page, page.getViewport({ scale: 1 }), 1);
    await Promise.resolve();

    expect(renderer.getBitmapArea()).toBeGreaterThan(0);
    renderer.release();
    expect(renderer.getBitmapArea()).toBe(0);
  });

  it('开始新渲染时取消在途的过期渲染任务', async () => {
    const page = makeFakePage({ width: 200, height: 300 });
    let latestTask = makePendingRenderTask();
    const renderer = new PdfPageRenderer(1, () => {
      latestTask = makePendingRenderTask();
      return latestTask;
    });
    void renderer.render(page, page.getViewport({ scale: 1 }), 1);
    await Promise.resolve();

    const firstTask = latestTask;
    void renderer.render(page, page.getViewport({ scale: 2 }), 1);
    await Promise.resolve();

    expect(firstTask.cancelled).toBe(true);
  });

  it('release 取消在途任务并释放位图', async () => {
    const page = makeFakePage({ width: 200, height: 300 });
    let latestTask = makePendingRenderTask();
    const renderer = new PdfPageRenderer(1, () => {
      latestTask = makePendingRenderTask();
      return latestTask;
    });
    void renderer.render(page, page.getViewport({ scale: 1 }), 1);
    await Promise.resolve();

    renderer.release();
    expect(latestTask.cancelled).toBe(true);
    expect(renderer.getBitmapArea()).toBe(0);
  });

  it('扫描页无文字层时仍正常显示页面图像', async () => {
    const page = makeFakePage({ width: 200, height: 300 }) as PdfPage;
    (page.streamTextContent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('no text layer'),
    );
    const renderer = new PdfPageRenderer(1, () => makeFakeRenderTask());
    void renderer.render(page, page.getViewport({ scale: 1 }), 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 文本层读取失败不阻塞页面图像渲染。
    expect(renderer.getBitmapArea()).toBeGreaterThan(0);
  });

  it('扫描页拖选区域时回调页码和归一化矩形', async () => {
    const page = makeFakePage({ width: 200, height: 300 });
    const onAreaSelection = vi.fn();
    const renderer = new PdfPageRenderer(2, () => makeFakeRenderTask(), { onAreaSelection });
    vi.spyOn(renderer.element, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      width: 200,
      height: 300,
      right: 300,
      bottom: 350,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect);

    void renderer.render(page, page.getViewport({ scale: 1 }), 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    renderer.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 140, clientY: 110 }));
    renderer.element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 240, clientY: 260 }));
    renderer.element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 240, clientY: 260 }));

    expect(onAreaSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        rect: expect.objectContaining({ x: 0.2, y: 0.2 }),
      }),
    );
    expect(onAreaSelection.mock.calls[0]?.[0].rect.width).toBeCloseTo(0.5, 6);
    expect(onAreaSelection.mock.calls[0]?.[0].rect.height).toBeCloseTo(0.5, 6);
  });

  it('有文字层时拖拽不抢占文本选择手势', async () => {
    const page = makeFakePage({ width: 200, height: 300 }, [
      { str: '可选择文字', transform: [1, 0, 0, 1, 0, 0], width: 80, height: 12 },
    ]);
    const onAreaSelection = vi.fn();
    const renderer = new PdfPageRenderer(1, () => makeFakeRenderTask(), { onAreaSelection });
    vi.spyOn(renderer.element, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 50, width: 200, height: 300,
      right: 300, bottom: 350, x: 100, y: 50,
      toJSON: () => ({}),
    } as DOMRect);

    void renderer.render(page, page.getViewport({ scale: 1 }), 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderer.element.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 140, clientY: 110 }));
    renderer.element.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 240, clientY: 260 }));

    expect(onAreaSelection).not.toHaveBeenCalled();
  });
});
