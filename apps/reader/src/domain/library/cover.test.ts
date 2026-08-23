import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeCoverBlob } from './cover';

describe('normalizeCoverBlob', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('拒绝超过资源预算的来源封面而不把它带入导入提交', async () => {
    const oversized = new Blob([new Uint8Array(64 * 1024 * 1024 + 1)], {
      type: 'image/png',
    });

    await expect(normalizeCoverBlob(oversized)).resolves.toBeNull();
  });

  it('没有可用安全解码器时将损坏封面降级为无封面', async () => {
    const invalid = new Blob(['not-an-image'], { type: 'image/png' });

    await expect(normalizeCoverBlob(invalid)).resolves.toBeNull();
  });

  it('缩放来源封面后释放 ImageBitmap 与临时 Canvas', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1024, height: 512, close })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    let renderedCanvas: HTMLCanvasElement | undefined;
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      renderedCanvas = this;
      callback(new Blob(['normalized'], { type: 'image/jpeg' }));
    });

    const result = await normalizeCoverBlob(new Blob(['source'], { type: 'image/png' }));

    expect(result?.mimeType).toBe('image/jpeg');
    expect(close).toHaveBeenCalledOnce();
    expect((renderedCanvas as HTMLCanvasElement | undefined)?.width).toBe(0);
    expect((renderedCanvas as HTMLCanvasElement | undefined)?.height).toBe(0);
  });

  it('拒绝超过解码像素预算的封面并释放已解码图片', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 20_000,
      height: 20_000,
      close,
    })));

    await expect(
      normalizeCoverBlob(new Blob(['small-source'], { type: 'image/png' })),
    ).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
});
