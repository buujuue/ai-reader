import type { PdfFileSource } from './pdfLibrary';

/**
 * PDF.js 范围读取的并发上限传输。
 *
 * 解析大 PDF 的跨引用表与对象流时,PDF.js 会在一次突发内请求成百上千个字节
 * 范围。真实 HTTP 传输受浏览器每主机连接数(~6)隐式限流;自定义文件桥接
 * (Tauri 托管文件经 `slice().arrayBuffer()` 读取)没有该限制,若一次性全部
 * 派发会洪泛平台读取并耗尽 WebView 堆(参考 Readest 大 PDF OOM 修复:
 * `packages/foliate-js/pdf.js` 的 MAX_CONCURRENT_RANGES)。这里用队列把并发
 * 上限钉在固定值,保证大文件也能稳定解析。
 */

/** 范围读取的默认并发上限。 */
export const MAX_CONCURRENT_RANGES = 6;

/** 并发限制传输的运行时观测(供测试断言)。 */
export interface ConcurrentRangeRuntime {
  /** 当前在途读取数。 */
  readonly active: number;
  /** 排队未派发的范围数。 */
  readonly queued: number;
  /** 是否已经取消后续读取。 */
  readonly cancelled: boolean;
}

/** PDF.js 范围读取失败,保留失败区间供打开错误展示与日志诊断。 */
export class PdfRangeReadError extends Error {
  override name = 'PdfRangeReadError';

  constructor(
    readonly begin: number,
    readonly end: number,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`PDF 范围读取失败:[${begin},${end}) ${detail}`);
  }
}

export interface ConcurrentRangeTransport {
  transport: PdfDataRangeTransportLike;
  runtime: ConcurrentRangeRuntime;
  /** 取消排队范围并忽略已在途读取的结果。 */
  cancel(): void;
  /** 暂停挂起 Runtime 的排队读取；已在途读取安全完成，恢复后可继续请求。 */
  pause(): void;
  /** 恢复挂起 Runtime 的范围请求调度。 */
  resume(): void;
  /** 等待已经暂停的传输收敛到没有在途读取；超时返回 false。 */
  waitForIdle(timeoutMs?: number): Promise<boolean>;
  /** 订阅底层范围读取失败;失败后传输会停止提交后续数据。 */
  onFailure(listener: (error: PdfRangeReadError) => void): () => void;
}

/** 让 PDF.js 无失败回调的异步操作仍能把 Source 读取错误交给上层。 */
export async function withRangeFailure<T>(
  operation: Promise<T>,
  range: ConcurrentRangeTransport,
): Promise<T> {
  let unsubscribe: () => void = () => undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    unsubscribe = range.onFailure(reject);
  });
  try {
    return await Promise.race([operation, failure]);
  } finally {
    unsubscribe();
  }
}

/**
 * 创建带并发上限的 PDF.js 范围传输。返回的 `transport` 需作为
 * `getDocument({ range })` 的 `range` 使用;`runtime` 暴露在途/排队观测。
 */
export function createConcurrentRangeTransport(
  file: PdfFileSource,
  makeTransport: (size: number, initialData: unknown) => PdfDataRangeTransportLike,
  maxConcurrent: number = MAX_CONCURRENT_RANGES,
): ConcurrentRangeTransport {
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new RangeError(`PDF 文件大小无效:${file.size}`);
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(`PDF 范围读取并发上限无效:${maxConcurrent}`);
  }

  const transport = makeTransport(file.size, new Uint8Array());
  let active = 0;
  const queue: Array<[number, number]> = [];
  let cancelled = false;
  let paused = false;
  let failure: PdfRangeReadError | null = null;
  const failureListeners = new Set<(error: PdfRangeReadError) => void>();
  const idleWaiters = new Set<(settled: boolean) => void>();

  const resolveIdleWaiters = (): void => {
    if (active !== 0) return;
    for (const resolve of idleWaiters) resolve(true);
    idleWaiters.clear();
  };

  const baseAbort = transport.abort;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    queue.length = 0;
    baseAbort?.();
  };

  const reportFailure = (begin: number, end: number, error: unknown): void => {
    if (failure || cancelled) return;
    failure = error instanceof PdfRangeReadError
      ? error
      : new PdfRangeReadError(begin, end, error);
    cancel();
    for (const listener of failureListeners) {
      listener(failure);
    }
  };

  const pump = (): void => {
    while (!cancelled && !paused && active < maxConcurrent && queue.length > 0) {
      const [begin, end] = queue.shift() as [number, number];
      active += 1;
      file
        .slice(begin, end)
        .arrayBuffer()
        .then((chunk) => {
          if (!cancelled) {
            transport.onDataRange(begin, chunk);
          }
        })
        .catch((error: unknown) => {
          // PDFDataRangeTransport 没有公开的失败回调,因此由外层打开流程订阅
          // 自有失败事件;绝不提交伪数据,也不让失败请求静默变成永久等待。
          reportFailure(begin, end, error);
        })
        .finally(() => {
          active -= 1;
          resolveIdleWaiters();
          pump();
        });
    }
  };

  transport.requestDataRange = (begin: number, end: number): void => {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin || end > file.size) {
      throw new RangeError(`PDF 范围读取越界:[${begin},${end})/${file.size}`);
    }
    if (cancelled || begin === end) {
      if (!cancelled && begin === end) {
        transport.onDataRange(begin, new ArrayBuffer(0));
      }
      return;
    }
    queue.push([begin, end]);
    pump();
  };

  transport.abort = cancel;

  return {
    transport,
    runtime: {
      get active() {
        return active;
      },
      get queued() {
        return queue.length;
      },
      get cancelled() {
        return cancelled;
      },
    },
    cancel,
    pause: () => {
      if (cancelled) return;
      paused = true;
    },
    resume: () => {
      if (cancelled) return;
      paused = false;
      pump();
    },
    waitForIdle(timeoutMs = 1_000) {
      if (active === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          timer = null;
          idleWaiters.delete(resolveIdle);
          resolve(false);
        }, Math.max(0, timeoutMs));
        const resolveIdle = (settled: boolean): void => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          idleWaiters.delete(resolveIdle);
          resolve(settled);
        };
        idleWaiters.add(resolveIdle);
        resolveIdleWaiters();
      });
    },
    onFailure(listener) {
      if (failure) {
        listener(failure);
        return () => undefined;
      }
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },
  };
}

/** 与 pdfLibrary 的 PdfDataRangeTransport 兼容的最小形状。 */
export interface PdfDataRangeTransportLike {
  onDataRange(begin: number, chunk: ArrayBuffer): void;
  requestDataRange?(begin: number, end: number): void;
  abort?(): void;
}
