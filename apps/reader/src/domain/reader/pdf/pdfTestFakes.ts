import { vi } from 'vitest';

import type {
  PdfDocumentProxy,
  PdfJsLib,
  PdfPage,
  PdfRenderTask,
  PdfViewport,
} from './pdfLibrary';
import type { PdfPageRasterizer } from './pdfPageRenderer';

/**
 * PDF 领域测试公共伪对象:让 PdfBookDocument / PdfRenderer / PdfPageRenderer
 * 在无真实 PDF.js 引擎与 canvas 2d 环境下验证协调逻辑。测试用,不进入生产构建路径。
 */

/** 页面尺寸规格(单位:CSS 像素,CSS 缩放 1 时的自然尺寸)。 */
export interface FakePageSpec {
  width: number;
  height: number;
}

/** 伪页面文本项(带几何,供文本层/搜索测试)。 */
export interface FakeTextItem {
  str: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
  hasEOL?: boolean;
}

/** 可追踪的渲染任务(可取消、可标记已取消)。 */
export interface FakeRenderTask extends PdfRenderTask {
  readonly cancelled: boolean;
}

export function makeFakeRenderTask(): FakeRenderTask {
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    promise: Promise.resolve(),
    cancel: () => {
      cancelled = true;
    },
  };
}

/** 永不 resolve 的渲染任务:用于验证取消逻辑(渲染在途时被释放/替换)。 */
export function makePendingRenderTask(): FakeRenderTask {
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    promise: new Promise(() => undefined),
    cancel: () => {
      cancelled = true;
    },
  };
}

/** 构造伪 PDF 页面:getViewport 按 scale 线性放大,渲染/文本层为安全空实现。 */
export function makeFakePage(spec: FakePageSpec, textItems: FakeTextItem[] = []): PdfPage {
  return {
    getViewport(options: { scale: number }): PdfViewport {
      return { width: spec.width * options.scale, height: spec.height * options.scale };
    },
    render: vi.fn((): PdfRenderTask => makeFakeRenderTask()),
    streamTextContent: vi.fn(async () => ({ items: textItems, styles: {} })),
    getTextContent: vi.fn(async () => ({ items: textItems, styles: {} })),
    getAnnotations: vi.fn(async () => []),
    cleanup: vi.fn(),
  };
}

/** 构造伪文档代理:numPages 页,getPage 返回对应伪页面。 */
export function makeFakeDocument(pageCount: number, specs: FakePageSpec[] = []): PdfDocumentProxy {
  const pages = Array.from(
    { length: pageCount },
    (_, index) => makeFakePage(specs[index] ?? { width: 595, height: 842 }),
  );
  return {
    numPages: pageCount,
    getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]!),
    getMetadata: vi.fn(async () => ({
      info: { Title: '示例 PDF', Author: '示例作者' },
      metadata: null,
    })),
    getOutline: vi.fn(async () => null),
    getDestination: vi.fn(async () => null),
    getPageIndex: vi.fn(async () => 0),
    destroy: vi.fn(async () => undefined),
    pages,
  } as unknown as PdfDocumentProxy & { pages: PdfPage[] };
}

/** 构造伪 PDF.js 库窄接口:getDocument 返回指定伪文档。 */
export function makeFakeLib(document: PdfDocumentProxy): PdfJsLib {
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    PDFDataRangeTransport: class {
      constructor(
        public readonly length: number,
        public readonly initialData: unknown,
      ) {}
      onDataRange(): void {
        // 由并发限制传输在读取完成后调用,伪实现不消费。
      }
    },
    getDocument: vi.fn(() => ({ promise: Promise.resolve(document) })),
  };
}

/** 惰性成功的页面光栅化函数:记录调用,不真正绘制(测试用)。 */
export function makeFakeRasterizer(
  onRender?: (page: PdfPage, canvas: HTMLCanvasElement, scale: number) => void,
): PdfPageRasterizer {
  return (page, canvas, scale): PdfRenderTask => {
    onRender?.(page, canvas, scale);
    return makeFakeRenderTask();
  };
}