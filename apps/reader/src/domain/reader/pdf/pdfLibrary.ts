/**
 * PDF.js 的窄接口与懒加载引导。
 *
 * 本模块集中所有对 `pdfjs-dist` 引擎的直接调用点(ADR-0004:外部 Module
 * 不直接操作具体渲染器对象/PDF.js 对象)。PdfBookDocument 与 PdfInspector
 * 都通过本模块注入的 `PdfJsLib` 交互;测试注入伪实现,生产懒加载真实引擎。
 *
 * 安全边界(ADR-0010):PDF 内容不可信。`isEvalSupported` 关闭,避免 PDF.js
 * 在页面内执行字符串求值;渲染只输出到 Canvas 与文本层 DOM,不执行书内脚本。
 * 范围读取(HttpsV2Transport)可控并发上限,防止大文件跨引用/对象流请求洪泛
 * 原生文件桥接(参考 Readest `packages/foliate-js/pdf.js` 的 MAX_CONCURRENT_RANGES)。
 */

// worker 经 Vite 按独立资源解析。注意:不要用 `?url` 后缀(如 `new URL('...mjs?url',
// import.meta.url)` 或 `import x from '...mjs?url'`),否则 dev 模式下 vite 会把 worker
// 请求当作「返回 URL 字符串」处理,worker 拿到非法脚本导致初始化永久挂起(工单 #16)。
// 用不带 `?url` 的 `new URL(...)`,vite 会把它解析为可直接作模块 worker 加载的干净资源
// URL(dev 为 `/@fs/...`,构建为 `/assets/pdf.worker.*.mjs`)。

/** PDF.js 页面视口(只读窄描述)。 */
export interface PdfViewport {
  readonly width: number;
  readonly height: number;
}

/** PDF.js 渲染任务(可取消)。 */
export interface PdfRenderTask {
  readonly promise: Promise<unknown>;
  cancel(): void;
}

/** PDF.js 文本内容项(用于文本层;扫描页无文字层时为空)。 */
export interface PdfTextItem {
  readonly str: string;
  /** 文本空间到 PDF 用户空间的 2D 仿射变换 [a,b,c,d,e,f],用于文本层定位。 */
  readonly transform?: number[];
  /** 该文本片段的渲染宽度(PDF 用户空间单位)。 */
  readonly width?: number;
  /** 该文本片段的高度(PDF 用户空间单位)。 */
  readonly height?: number;
  /** 字体名(文本层样式缓存键)。 */
  readonly fontName?: string;
  /** 是否在片段后换行(文本层据此插入 <br>)。 */
  readonly hasEOL?: boolean;
}

/** PDF.js 文本内容。 */
export interface PdfTextContent {
  readonly items: PdfTextItem[];
  /** 字体样式映射(按 fontName 索引),用于文本层定位。 */
  readonly styles?: Record<string, { fontFamily?: string; vertical?: boolean }>;
}

/** PDF.js 文本内容读取参数。 */
export interface PdfTextContentParameters {
  readonly includeMarkedContent?: boolean;
  readonly disableNormalization?: boolean;
}

/** PDF.js 页面对象(窄接口)。 */
export interface PdfPage {
  getViewport(options: { scale: number }): PdfViewport;
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): PdfRenderTask;
  /** PDF.js 5.x 的流式接口返回 ReadableStream,不是完整 TextContent 对象。 */
  streamTextContent(options?: PdfTextContentParameters): ReadableStream<PdfTextContent>;
  /** 返回已聚合的文本内容,适合当前需要一次性建立自定义文本层的实现。 */
  getTextContent(options?: PdfTextContentParameters): Promise<PdfTextContent>;
  getAnnotations(): Promise<unknown[]>;
  /** 释放页面解码缓存(如字体/字形),用于内存预算回收。 */
  cleanup(): void;
}

/** PDF.js 文档代理(窄接口)。 */
export interface PdfDocumentProxy {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown>; metadata?: PdfMetadata }>;
  getOutline(): Promise<Array<PdfOutlineItem> | null>;
  getDestination(name: string): Promise<unknown>;
  getPageIndex(ref: unknown): Promise<number>;
  destroy(): Promise<void>;
}

/** PDF.js 元数据对象(窄接口)。 */
export interface PdfMetadata {
  get(name: string): string | null;
  getRaw(): string | null;
}

/** PDF.js 目录条目(窄接口)。 */
export interface PdfOutlineItem {
  title: string;
  dest?: unknown;
  items?: PdfOutlineItem[];
}

/** PDF.js 范围读取传输:由调用方填充 `requestDataRange`。 */
export interface PdfDataRangeTransport {
  onDataRange(begin: number, chunk: ArrayBuffer): void;
  requestDataRange?(begin: number, end: number): void;
  /** PDF.js 在销毁加载任务时调用;自定义传输用它取消排队读取。 */
  abort?(): void;
}

/** PDF.js 加载任务,保留可选销毁句柄以支持打开阶段的取消。 */
export interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  destroy?: () => Promise<void> | void;
}

/** PDF.js 只读范围来源的最小 File/Blob 兼容形状。 */
export interface PdfFileSource {
  readonly size: number;
  slice(begin?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** PDF.js 库的窄接口(用于注入与测试)。 */
export interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  PDFDataRangeTransport: new (length: number, initialData: unknown) => PdfDataRangeTransport;
  getDocument(options: {
    range: PdfDataRangeTransport;
    isEvalSupported: boolean;
    /** 禁止 PDF.js 自己建立整文件流,保持所有内容通过范围队列取得。 */
    disableStream?: boolean;
    /** 禁止解析阶段预取后续内容,由页面/文档按需触发范围请求。 */
    disableAutoFetch?: boolean;
  }): PdfLoadingTask;
}

/** 测试与导入兼容路径:把已有字节包装成范围来源,不再作为 PDF.js `data` 传入。 */
export function createPdfSourceFromBytes(bytes: Uint8Array): PdfFileSource {
  // 该兼容路径只在导入暂存阶段使用;PDF.js 仍只拿到按请求切出的范围,
  // 不在这里额外复制整份文件。
  const ownedBytes = bytes;
  return {
    size: ownedBytes.byteLength,
    slice(begin = 0, end = ownedBytes.byteLength) {
      const start = Math.max(0, Math.min(ownedBytes.byteLength, begin));
      const stop = Math.max(start, Math.min(ownedBytes.byteLength, end));
      return {
        arrayBuffer: async () => ownedBytes.slice(start, stop).buffer as ArrayBuffer,
      };
    },
  };
}

/** 懒加载并引导 PDF.js 引擎的缓存的 Promise。 */
let pdfLibPromise: Promise<PdfJsLib> | null = null;

/**
 * 加载 PDF.js。生产环境懒加载 `pdfjs-dist` 并配置 worker;测试环境不调用本函数
 * (PdfBookDocument/PdfInspector 注入伪引擎)。worker 经 Vite `?url` 作为独立资源
 * 输出,避免在渲染线程内联大体积 worker。
 */
export function loadPdfLib(): Promise<PdfJsLib> {
  if (!pdfLibPromise) {
    pdfLibPromise = import('pdfjs-dist').then((module) => {
      const lib = module as unknown as PdfJsLib;
      // 不带 `?url`,vite 解析为可直接加载的干净 worker 资源 URL(dev 和构建均如此)。
      const workerUrl = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      return lib;
    });
  }
  return pdfLibPromise;
}

/** 测试用:重置懒加载缓存,便于在测试间替换。 */
export function resetPdfLibCacheForTest(): void {
  pdfLibPromise = null;
}
