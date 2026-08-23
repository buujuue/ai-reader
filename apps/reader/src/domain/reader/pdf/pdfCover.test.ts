import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeFakePage } from './pdfTestFakes';
import { renderPdfPageCover } from './pdfCover';

describe('renderPdfPageCover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('渲染首页并在成功后释放 Canvas 与 PDF 页面资源', async () => {
    const context = {} as CanvasRenderingContext2D;
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((callback) => callback(new Blob(['cover'], { type: 'image/png' })));
    const page = makeFakePage({ width: 595, height: 842 });

    const result = await renderPdfPageCover(page);

    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.failure).toBeUndefined();
    expect(page.render).toHaveBeenCalledTimes(1);
    expect(page.cleanup).toHaveBeenCalledTimes(1);
    expect(getContext).toHaveBeenCalledWith('2d');
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
  });

  it('透明空白页返回可诊断降级且不编码封面', async () => {
    const context = {
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(595 * 842 * 4) })),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
    const page = makeFakePage({ width: 595, height: 842 });

    const result = await renderPdfPageCover(page);

    expect(result).toEqual({ blob: null, failure: 'blank' });
    expect(toBlob).not.toHaveBeenCalled();
    expect(page.cleanup).toHaveBeenCalledTimes(1);
  });

  it('渲染失败时取消任务并释放页面资源', async () => {
    const context = {} as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const cancel = vi.fn();
    const page = makeFakePage({ width: 595, height: 842 });
    (page.render as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.reject(new Error('render failed')),
      cancel,
    });

    const result = await renderPdfPageCover(page);

    expect(result).toEqual({ blob: null, failure: 'render-failed' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(page.cleanup).toHaveBeenCalledTimes(1);
  });

  it('取消信号会结束等待中的渲染并释放页面资源', async () => {
    const context = {} as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const controller = new AbortController();
    const cancel = vi.fn();
    const page = makeFakePage({ width: 595, height: 842 });
    (page.render as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: new Promise(() => undefined),
      cancel,
    });

    const promise = renderPdfPageCover(page, { signal: controller.signal });
    controller.abort();

    await expect(promise).resolves.toEqual({ blob: null, failure: 'cancelled' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(page.cleanup).toHaveBeenCalledTimes(1);
  });
});
