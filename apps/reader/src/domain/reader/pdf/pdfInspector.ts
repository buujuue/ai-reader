import { normalizeCoverBlob } from '../../library/cover';
import type { CoverAsset, SourceMetadata } from '../../library/material';
import type { PdfDocumentProxy, PdfFileSource, PdfJsLib, PdfLoadingTask } from './pdfLibrary';
import { createPdfSourceFromBytes, getPdfJsWasmUrl, loadPdfLib } from './pdfLibrary';
import { renderPdfPageCover, type PdfCoverRenderFailure } from './pdfCover';
import { createConcurrentRangeTransport, withRangeFailure } from './pdfRangeTransport';

/** 检查失败的领域化分类,前端据此展示可行动的简体中文文案。 */
export type PdfInspectErrorKind = 'empty' | 'unsupported' | 'corrupt';

/** 领域化错误:文件为空、不是受支持格式或结构损坏时抛出。 */
export class PdfInspectError extends Error {
  override name = 'PdfInspectError';
  constructor(
    message: string,
    readonly kind: PdfInspectErrorKind,
  ) {
    super(message);
  }
}

export interface PdfInspectResult {
  /** 从 PDF Info 字典与 XMP 元数据提取的来源元数据。 */
  metadata: SourceMetadata;
  /** 页数,用于书库展示与阅读视口预估。 */
  pageCount: number;
  /** 首页渲染得到的标准来源封面;失败时为 null,不影响 PDF 正文导入。 */
  sourceCover: CoverAsset | null;
  /** 封面派生失败的可诊断提示;正文检查仍然成功。 */
  coverWarning?: string;
}

export interface PdfInspectOptions {
  /** 阅读器打开阶段只需要元数据时关闭一次性首页封面派生。 */
  includeCover?: boolean;
}

const PDF_HEADER = '%PDF-';

/** 在文件前 1024 字节内查找 PDF 头(`%PDF-`),PDF.js 也允许头偏移出现。 */
function findPdfHeader(bytes: Uint8Array): boolean {
  const windowEnd = Math.min(bytes.length, 1024);
  const window = new TextDecoder('latin1').decode(bytes.subarray(0, windowEnd));
  return window.includes(PDF_HEADER);
}

/** 把 XMP/Info 元数据值归一化为 string | null:数组(如多作者 dc:creator)以「、」连接。 */
function toStringOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const joined = value.filter((item) => typeof item === 'string').join('、');
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/**
 * 检查一份 PDF 范围来源,提取来源元数据与页数。
 * 这是 BookDocument 的雏形:只解析文档代理与元数据,不进入页面渲染。
 * `lib` 可注入伪引擎用于测试;生产默认懒加载真实 PDF.js。
 *
 * 兼容旧导入调用方接受 Uint8Array,但也会先包装成范围来源;PDF.js 永远只
 * 接收 PDFDataRangeTransport,不会收到完整 `data` 副本。
 */
export async function inspectPdf(
  sourceOrBytes: PdfFileSource | Uint8Array,
  lib?: PdfJsLib,
  options: PdfInspectOptions = {},
): Promise<PdfInspectResult> {
  // 不使用 `instanceof Uint8Array`:调用方可能来自不同 WebView realm,跨 realm
  // 的 TypedArray 会让 instanceof 失效。File/Blob 兼容来源稳定拥有 size。
  const source = typeof (sourceOrBytes as Partial<PdfFileSource>).size === 'number'
    ? (sourceOrBytes as PdfFileSource)
    : createPdfSourceFromBytes(sourceOrBytes as Uint8Array);
  if (source.size === 0) {
    throw new PdfInspectError('文件内容为空,无法导入', 'empty');
  }
  let hasHeader = false;
  try {
    const headerBytes = new Uint8Array(
      await source.slice(0, Math.min(source.size, 1024)).arrayBuffer(),
    );
    hasHeader = findPdfHeader(headerBytes);
  } catch (error) {
    throw new PdfInspectError(
      `读取 PDF 失败:${error instanceof Error ? error.message : String(error)}`,
      'corrupt',
    );
  }
  const pdfLib = lib ?? (await loadPdfLib());
  const range = createConcurrentRangeTransport(
    source,
    (size, initialData) => new pdfLib.PDFDataRangeTransport(size, initialData),
  );
  let loadingTask: PdfLoadingTask | null = null;
  let document: PdfDocumentProxy | null = null;
  try {
    loadingTask = pdfLib.getDocument({
      range: range.transport,
      isEvalSupported: false,
      wasmUrl: getPdfJsWasmUrl(),
      disableStream: true,
      disableAutoFetch: true,
    });
    document = await withRangeFailure(loadingTask.promise, range);
    const { info, metadata } = await withRangeFailure(document.getMetadata(), range);
    // XMP 元数据(dc:title / dc:creator / dc:language)可能返回数组(如多作者),而
    // SourceMetadata 只接受 string | null。统一归一化为字符串:数组以「、」连接,
    // 否则回退到 info 字典里的字符串值。否则多作者 PDF 的 author 会以数组形式传给
    // Rust 的 commit_import,序列化失败("invalid type: sequence, expected a string")而导入失败。
    const title = toStringOrNull(metadata?.get('dc:title')) ?? (typeof info?.Title === 'string' ? info.Title : null);
    const author = toStringOrNull(metadata?.get('dc:creator')) ?? (typeof info?.Author === 'string' ? info.Author : null);
    const language = toStringOrNull(metadata?.get('dc:language'));
    const pageCount = document.numPages;
    let sourceCover: CoverAsset | null = null;
    let coverWarning: string | undefined;
    if (options.includeCover === false) {
      // 打开已有材料时封面已经在导入阶段托管,避免重复渲染首页。
    } else if (pageCount <= 0) {
      coverWarning = 'PDF 没有可渲染的首页,已使用封面占位';
    } else {
      try {
        const page = await withRangeFailure(document.getPage(1), range);
        const rendered = await renderPdfPageCover(page);
        if (rendered.blob) {
          sourceCover = await normalizeCoverBlob(rendered.blob);
        }
        if (!sourceCover) {
          coverWarning = coverWarningFor(rendered.failure);
        }
      } catch {
        coverWarning = 'PDF 首页无法读取或渲染,已使用封面占位';
      }
    }
    return {
      metadata: {
        // 极少数 PDF 无任何标题元数据,回退为空串(界面展示占位),成品书库仍可收录。
        title: title ?? '',
        author,
        language,
      },
      pageCount,
      sourceCover,
      ...(coverWarning ? { coverWarning } : {}),
    };
  } catch (error) {
    if (error instanceof PdfInspectError) {
      throw error;
    }
    const detail = error instanceof Error && error.message.trim().length > 0
      ? `:${error.message}`
      : '';
    if (hasHeader) {
      throw new PdfInspectError(`文件已损坏:无法解析 PDF 结构${detail}`, 'corrupt');
    }
    throw new PdfInspectError(`不支持的文件格式:无法解析 PDF 结构${detail}`, 'unsupported');
  } finally {
    range.cancel();
    if (document) {
      await document.destroy().catch(() => undefined);
    } else {
      await Promise.resolve(loadingTask?.destroy?.()).catch(() => undefined);
    }
  }
}

function coverWarningFor(failure: PdfCoverRenderFailure | undefined): string {
  switch (failure) {
    case 'blank':
      return 'PDF 首页为空白页,已使用封面占位';
    case 'cancelled':
      return 'PDF 首页封面渲染已取消,已使用封面占位';
    case 'encode-failed':
      return 'PDF 首页无法编码为封面,已使用封面占位';
    default:
      return 'PDF 首页无法渲染为来源封面,已使用封面占位';
  }
}
