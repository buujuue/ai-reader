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

/** 可范围读取的文件窄接口(与 File/Blob 的 slice 语义一致)。 */
export interface RangeFileLike {
  readonly size: number;
  slice(begin: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** 并发限制传输的运行时观测(供测试断言)。 */
export interface ConcurrentRangeRuntime {
  /** 当前在途读取数。 */
  readonly active: number;
  /** 排队未派发的范围数。 */
  readonly queued: number;
}

/**
 * 创建带并发上限的 PDF.js 范围传输。返回的 `transport` 需作为
 * `getDocument({ range })` 的 `range` 使用;`runtime` 暴露在途/排队观测。
 */
export function createConcurrentRangeTransport(
  file: RangeFileLike,
  makeTransport: (size: number, initialData: unknown) => PdfDataRangeTransportLike,
  maxConcurrent: number = MAX_CONCURRENT_RANGES,
): { transport: PdfDataRangeTransportLike; runtime: ConcurrentRangeRuntime } {
  const transport = makeTransport(file.size, []);
  let active = 0;
  const queue: Array<[number, number]> = [];

  const pump = (): void => {
    while (active < maxConcurrent && queue.length > 0) {
      const [begin, end] = queue.shift() as [number, number];
      active += 1;
      file
        .slice(begin, end)
        .arrayBuffer()
        .then((chunk) => {
          transport.onDataRange(begin, chunk);
        })
        .catch(() => {
          // 某段读取失败:交给 PDF.js 的文档解析流程自行报错,这里只释放并发槽。
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  transport.requestDataRange = (begin: number, end: number): void => {
    queue.push([begin, end]);
    pump();
  };

  return {
    transport,
    runtime: {
      get active() {
        return active;
      },
      get queued() {
        return queue.length;
      },
    },
  };
}

/** 与 pdfLibrary 的 PdfDataRangeTransport 兼容的最小形状。 */
export interface PdfDataRangeTransportLike {
  onDataRange(begin: number, chunk: ArrayBuffer): void;
  requestDataRange?(begin: number, end: number): void;
}