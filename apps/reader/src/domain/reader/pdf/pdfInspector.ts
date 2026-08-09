import type { SourceMetadata } from '../../library/material';
import type { PdfJsLib } from './pdfLibrary';
import { loadPdfLib } from './pdfLibrary';

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
 * 检查一份 PDF 字节内容,提取来源元数据与页数。
 * 这是 BookDocument 的雏形:只解析文档代理与元数据,不进入页面渲染。
 * `lib` 可注入伪引擎用于测试;生产默认懒加载真实 PDF.js。
 */
export async function inspectPdf(bytes: Uint8Array, lib?: PdfJsLib): Promise<PdfInspectResult> {
  if (bytes.length === 0) {
    throw new PdfInspectError('文件内容为空,无法导入', 'empty');
  }
  const hasHeader = findPdfHeader(bytes);
  const pdfLib = lib ?? (await loadPdfLib());
  try {
    // `getDocument({ data })` 会把 ArrayBuffer 转移给 worker 并脱离(已经是该 package 的
    // 既定行为),若直接传调用方的 `bytes`,返回后其 buffer 会被清零,导致后续用同一份
    // 字节打开阅读文档时读到空文件。这里先复制一份,保证调用方数据不被破坏(工单 #16)。
    const document = await pdfLib
      .getDocument({ data: bytes.slice(), isEvalSupported: false })
      .promise;
    const { info, metadata } = await document.getMetadata();
    // XMP 元数据(dc:title / dc:creator / dc:language)可能返回数组(如多作者),而
    // SourceMetadata 只接受 string | null。统一归一化为字符串:数组以「、」连接,
    // 否则回退到 info 字典里的字符串值。否则多作者 PDF 的 author 会以数组形式传给
    // Rust 的 commit_import,序列化失败("invalid type: sequence, expected a string")而导入失败。
    const title = toStringOrNull(metadata?.get('dc:title')) ?? (typeof info?.Title === 'string' ? info.Title : null);
    const author = toStringOrNull(metadata?.get('dc:creator')) ?? (typeof info?.Author === 'string' ? info.Author : null);
    const language = toStringOrNull(metadata?.get('dc:language'));
    const pageCount = document.numPages;
    await document.destroy().catch(() => undefined);
    return {
      metadata: {
        // 极少数 PDF 无任何标题元数据,回退为空串(界面展示占位),成品书库仍可收录。
        title: title ?? '',
        author,
        language,
      },
      pageCount,
    };
  } catch (error) {
    if (hasHeader) {
      throw new PdfInspectError('文件已损坏:无法解析 PDF 结构', 'corrupt');
    }
    throw new PdfInspectError('不支持的文件格式:无法解析 PDF 结构', 'unsupported');
  }
}