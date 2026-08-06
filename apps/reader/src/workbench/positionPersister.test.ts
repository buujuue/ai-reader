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
});