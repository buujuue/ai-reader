import type { PdfPage, PdfRenderTask } from './pdfLibrary';

/**
 * 首页来源封面渲染的单页安全上限。封面随后还会按书库协议缩到 512px，
 * 这里先限制 PDF 页面光栅化尺寸，避免超大纸张在导入检查阶段申请巨型 Canvas。
 */
export const PDF_COVER_MAX_RENDER_LONG_EDGE = 2048;

export type PdfCoverRenderFailure =
  | 'cancelled'
  | 'blank'
  | 'invalid-size'
  | 'context-unavailable'
  | 'render-failed'
  | 'encode-failed';

export interface PdfCoverRenderResult {
  blob: Blob | null;
  failure?: PdfCoverRenderFailure;
}

export interface PdfCoverRenderOptions {
  signal?: AbortSignal;
  /** 测试和调用方可关闭空白页检测；生产默认开启。 */
  detectBlank?: boolean;
}

/**
 * 将一个 PDF 页面渲染成临时 PNG Blob。
 *
 * 该函数只负责一次性派生封面，不创建长期阅读器状态。页面清理、渲染任务取消
 * 和 Canvas 位图释放都集中在 finally 中，供导入检查与 PdfBookDocument 复用。
 */
export async function renderPdfPageCover(
  page: PdfPage,
  options: PdfCoverRenderOptions = {},
): Promise<PdfCoverRenderResult> {
  const { signal, detectBlank = true } = options;
  if (signal?.aborted) {
    return { blob: null, failure: 'cancelled' };
  }

  let canvas: HTMLCanvasElement | null = null;
  let renderTask: PdfRenderTask | null = null;
  let renderSettled = false;
  let cancelRequested = false;
  let rejectAbort: ((reason?: unknown) => void) | null = null;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        rejectAbort = reject;
      })
    : null;
  const abortHandler = () => {
    cancelRequested = true;
    try {
      renderTask?.cancel();
    } catch {
      // PDF.js 可能已经释放了完成的任务;后续 finally 仍会清理页面和位图。
    }
    rejectAbort?.(new Error('PDF 封面渲染已取消'));
  };

  signal?.addEventListener('abort', abortHandler, { once: true });
  try {
    const naturalViewport = page.getViewport({ scale: 1 });
    const naturalLongEdge = Math.max(naturalViewport.width, naturalViewport.height);
    if (
      !Number.isFinite(naturalLongEdge) ||
      naturalLongEdge <= 0 ||
      !Number.isFinite(naturalViewport.width) ||
      !Number.isFinite(naturalViewport.height)
    ) {
      return { blob: null, failure: 'invalid-size' };
    }

    const scale = Math.min(1, PDF_COVER_MAX_RENDER_LONG_EDGE / naturalLongEdge);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      return { blob: null, failure: 'context-unavailable' };
    }

    renderTask = page.render({ canvasContext: context, viewport });
    const renderPromise = abortPromise
      ? Promise.race([renderTask.promise, abortPromise])
      : renderTask.promise;
    await renderPromise;
    renderSettled = true;
    if (signal?.aborted) {
      return { blob: null, failure: 'cancelled' };
    }
    if (detectBlank && isTransparentCanvas(context, canvas)) {
      return { blob: null, failure: 'blank' };
    }

    const blob = await canvasToBlob(canvas);
    return blob ? { blob } : { blob: null, failure: 'encode-failed' };
  } catch {
    return {
      blob: null,
      failure: signal?.aborted ? 'cancelled' : 'render-failed',
    };
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    if (renderTask && !renderSettled && !cancelRequested) {
      try {
        renderTask.cancel();
      } catch {
        // 忽略已结束任务的取消异常,确保页面和位图仍然释放。
      }
    }
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    try {
      page.cleanup();
    } catch {
      // 页面清理失败不能让正文导入失败;PDF 文档销毁时会再次回收。
    }
  }
}

function isTransparentCanvas(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): boolean {
  if (typeof context.getImageData !== 'function') {
    return false;
  }
  try {
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (const channel of data) {
      if (channel !== 0) {
        return false;
      }
    }
    return true;
  } catch {
    // 某些 WebView 不允许读取 Canvas 像素时保留已渲染结果,不要误判为空白。
    return false;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
}
