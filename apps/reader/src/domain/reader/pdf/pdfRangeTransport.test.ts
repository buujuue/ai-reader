import { describe, expect, it, vi } from 'vitest';

import {
  createConcurrentRangeTransport,
  MAX_CONCURRENT_RANGES,
} from './pdfRangeTransport';
import type { PdfFileSource } from './pdfLibrary';

const BATCH_MS = 5;

/** 构造一个可追踪在途读取的文件:每次 slice 递增 active,读毕递减。 */
function makeTrackingFile(batchMs = 5): {
  file: PdfFileSource;
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

  it('某段读取失败时停止队列并向上层报告区间上下文', async () => {
    const batchMs = 1;
    let active = 0;
    let maxActive = 0;
    const ranges: Array<[number, number]> = [];
    const file: PdfFileSource = {
      size: 10_000,
      slice(begin: number, end: number) {
        ranges.push([begin, end]);
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
    const failures: Error[] = [];
    const rangeTransport = createConcurrentRangeTransport(
      file,
      (size, _initial) => ({ length: size, onDataRange }),
      2,
    );
    rangeTransport.onFailure((error) => failures.push(error));
    rangeTransport.transport.requestDataRange?.(0, 10);
    rangeTransport.transport.requestDataRange?.(20, 30);
    rangeTransport.transport.requestDataRange?.(40, 50);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rangeTransport.runtime.active).toBe(0);
    expect(rangeTransport.runtime.queued).toBe(0);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(failures[0]).toMatchObject({ begin: 0, end: 10 });
    expect(ranges).not.toContainEqual([40, 50]);
    expect(onDataRange).not.toHaveBeenCalled();
  });

  it('取消时清空排队范围,并忽略已在途读取的结果', async () => {
    let releaseFirst!: (value: ArrayBuffer) => void;
    const onDataRange = vi.fn();
    const file: PdfFileSource = {
      size: 100,
      slice(begin: number) {
        if (begin === 0) {
          return { arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { releaseFirst = resolve; }) };
        }
        return { arrayBuffer: async () => new ArrayBuffer(10) };
      },
    };
    const { transport, runtime, cancel } = createConcurrentRangeTransport(
      file,
      (size, _initial) => ({ length: size, onDataRange }),
      1,
    );

    transport.requestDataRange?.(0, 10);
    transport.requestDataRange?.(10, 20);
    cancel();
    releaseFirst(new ArrayBuffer(10));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.cancelled).toBe(true);
    expect(runtime.active).toBe(0);
    expect(runtime.queued).toBe(0);
    expect(onDataRange).not.toHaveBeenCalled();
  });

  it('越界范围在触发底层读取前被拒绝', () => {
    const { file, ranges } = makeTrackingFile();
    const { transport } = createConcurrentRangeTransport(
      file,
      (size, _initial) => ({ length: size, onDataRange: vi.fn() }),
    );

    expect(() => transport.requestDataRange?.(-1, 10)).toThrow('范围读取越界');
    expect(() => transport.requestDataRange?.(10, 10_001)).toThrow('范围读取越界');
    expect(ranges).toHaveLength(0);
  });
});
