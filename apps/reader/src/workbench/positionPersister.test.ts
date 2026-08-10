import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThrottledPositionPersister } from './positionPersister';

describe('ThrottledPositionPersister', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('节流间隔内多次 update 只触发一次保存,且保存最新位置', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const persister = new ThrottledPositionPersister({ save, throttledMs: 100 });

    persister.update({ kind: 'epub', cfi: 'epubcfi(/6/1)' });
    persister.update({ kind: 'epub', cfi: 'epubcfi(/6/2)' });
    persister.update({ kind: 'epub', cfi: 'epubcfi(/6/3)' });

    await vi.advanceTimersByTimeAsync(100);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ kind: 'epub', cfi: 'epubcfi(/6/3)' });
  });

  it('没有位置变化时不触发保存', async () => {
    const save = vi.fn();
    const persister = new ThrottledPositionPersister({ save, throttledMs: 100 });

    await vi.advanceTimersByTimeAsync(100);

    expect(save).not.toHaveBeenCalled();
  });

  it('flush 立即写入最新位置并清空待写状态', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const persister = new ThrottledPositionPersister({ save, throttledMs: 100 });

    persister.update({ kind: 'epub', cfi: 'epubcfi(/6/5)' });
    await persister.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ kind: 'epub', cfi: 'epubcfi(/6/5)' });

    await persister.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('dispose 取消待写定时器并强制 flush 最新位置', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const persister = new ThrottledPositionPersister({ save, throttledMs: 100 });

    persister.update({ kind: 'epub', cfi: 'epubcfi(/6/9)' });
    await persister.dispose();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ kind: 'epub', cfi: 'epubcfi(/6/9)' });
  });

  it('并发 flush 会等待进行中的保存并继续写入期间到达的最新位置', async () => {
    let resolveFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const save = vi.fn(async () => {
      if (save.mock.calls.length === 1) await firstSave;
    });
    const persister = new ThrottledPositionPersister({ save, throttledMs: 100 });

    persister.update({ kind: 'epub', cfi: 'epubcfi(/6/1)' });
    const firstFlush = persister.flush();
    persister.update({ kind: 'epub', cfi: 'epubcfi(/6/2)' });
    const secondFlush = persister.flush();

    resolveFirst();
    await Promise.all([firstFlush, secondFlush]);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, { kind: 'epub', cfi: 'epubcfi(/6/2)' });
  });

  it('保存失败时 flush 向调用方传播错误', async () => {
    const error = new Error('保存失败');
    const save = vi.fn().mockRejectedValue(error);
    const persister = new ThrottledPositionPersister({ save, throttledMs: 100 });

    persister.update({ kind: 'epub', cfi: 'epubcfi(/6/7)' });

    await expect(persister.flush()).rejects.toBe(error);
  });

  it('保存失败会保留位置并允许后续 flush 重试', async () => {
    const error = new Error('暂时失败');
    let attempts = 0;
    const save = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw error;
    });
    const persister = new ThrottledPositionPersister({ save, throttledMs: 100 });
    const location = { kind: 'epub' as const, cfi: 'epubcfi(/6/8)' };

    persister.update(location);
    await expect(persister.flush()).rejects.toBe(error);
    await persister.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(location);
  });
});
