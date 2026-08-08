import { describe, expect, it, vi } from 'vitest';

import {
  createConcurrentRangeTransport,
  MAX_CONCURRENT_RANGES,
  type RangeFileLike,
} from './pdfRangeTransport';

const BATCH_MS = 5;

/** 构造一个可追踪在途读取的文件:每次 slice 递增 active,读毕递减。 */
function makeTrackingFile(batchMs = 5): {
  file: RangeFileLike;
  maxActive: { value: number };
  ranges: Array<[number, number]>;
} {
  const maxActive = { value: 0 };
  let active = 0;
  const ranges: Array<[number, number]> = [];
  return {
    ranges,
    maxActive,
    file: {
      size: 10_000,
      slice(begin: number, end: number) {
        ranges.push([begin, end]);
        active += 1;
        maxActive.value = Math.max(maxActive.value, active);
        return {
          arrayBuffer: async () => {
            await new Promise((resolve) => setTimeout(resolve, batchMs));
            active -= 1;
            return new ArrayBuffer(0);
          },
        };
      },
    },
  };
}

describe('createConcurrentRangeTransport 范围读取并发上限', () => {
  it('同时进行中的范围读取不超过给定并发上限', async () => {
    const { file, maxActive } = makeTrackingFile();
    const { transport, runtime } = createConcurrentRangeTransport(
      file,
      (size, _initial) => ({ length: size, onDataRange: vi.fn() }),
      2,
    );

    for (let i = 0; i < 8; i += 1) {
      transport.requestDataRange?.(i * 40, i * 40 + 40);
    }
    // 同步派发阶段:2 在途,其余排队。
    expect(runtime.active).toBe(2);
    expect(runtime.queued).toBe(6);

    // 等待所有读取完成。
    await new Promise((resolve) => setTimeout(resolve, BATCH_MS * 12));
    expect(runtime.active).toBe(0);
    expect(runtime.queued).toBe(0);
    expect(maxActive.value).toBeLessThanOrEqual(2);
  });

  it('默认并发上限为 MAX_CONCURRENT_RANGES', async () => {
    const { file, maxActive } = makeTrackingFile();
    const { transport, runtime } = createConcurrentRangeTransport(file, (size, _initial) => ({
      length: size,
      onDataRange: vi.fn(),
    }));

    for (let i = 0; i < MAX_CONCURRENT_RANGES * 2; i += 1) {
      transport.requestDataRange?.(i * 10, i * 10 + 10);
    }
    expect(runtime.active).toBe(MAX_CONCURRENT_RANGES);
    await new Promise((resolve) => setTimeout(resolve, BATCH_MS * 12));
    expect(maxActive.value).toBeLessThanOrEqual(MAX_CONCURRENT_RANGES);
  });

  it('读取完成后把数据块交给 PDF.js 传输的 onDataRange', async () => {
    const { file, ranges } = makeTrackingFile(1);
    const onDataRange = vi.fn();
    const { transport } = createConcurrentRangeTransport(
      file,
      (size, _initial) => ({ length: size, onDataRange }),
      1,
    );

    transport.requestDataRange?.(100, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ranges).toEqual([[100, 200]]);
    expect(onDataRange).toHaveBeenCalledTimes(1);
    expect(onDataRange).toHaveBeenCalledWith(100, expect.any(ArrayBuffer));
  });

  it('某段读取失败时释放并发槽并继续派发后续范围', async () => {
    const batchMs = 1;
    let active = 0;
    let maxActive = 0;
    const file: RangeFileLike = {
      size: 10_000,
      slice(begin: number) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return {
          arrayBuffer: async () => {
            await new Promise((resolve) => setTimeout(resolve, batchMs));
            active -= 1;
            if (begin === 0) {
              throw new Error('read failed');
            }
            return new ArrayBuffer(0);
          },
        };
      },
    };
    const onDataRange = vi.fn();
    const { transport, runtime } = createConcurrentRangeTransport(
      file,
      (size, _initial) => ({ length: size, onDataRange }),
      2,
    );

    transport.requestDataRange?.(0, 10);
    transport.requestDataRange?.(20, 30);
    transport.requestDataRange?.(40, 50);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.active).toBe(0);
    expect(runtime.queued).toBe(0);
    expect(maxActive).toBeLessThanOrEqual(2);
    // 失败段不触发 onDataRange,成功段正常回调。
    expect(onDataRange).toHaveBeenCalledTimes(2);
  });
});