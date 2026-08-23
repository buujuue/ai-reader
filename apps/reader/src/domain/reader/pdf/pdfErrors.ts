import { PdfRangeReadError } from './pdfRangeTransport';

/** PDF 阅读打开阶段可向工作台展示的错误分类。 */
export type PdfOpenErrorKind = 'corrupt' | 'range' | 'initialization';

/**
 * PDF 阅读错误的中文诊断包装。
 *
 * 原始错误保留在 cause 中供日志使用,界面只展示稳定的中文分类与必要范围,
 * 避免把 PDF.js/平台实现的英文内部文案直接暴露给用户。
 */
export class PdfOpenError extends Error {
  override name = 'PdfOpenError';

  constructor(
    readonly kind: PdfOpenErrorKind,
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
  }
}

/** 把 PDF.js 与托管范围来源的错误统一为可诊断的简体中文错误。 */
export function toPdfOpenError(error: unknown): PdfOpenError {
  if (error instanceof PdfOpenError) {
    return error;
  }
  if (error instanceof PdfRangeReadError) {
    return new PdfOpenError(
      'range',
      `PDF 范围读取失败（请求区间 [${error.begin},${error.end})），请检查托管文件是否完整。`,
      error,
    );
  }

  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/(invalid|corrupt|malformed|xref|trailer|eof|结构|损坏|格式)/i.test(detail)) {
    return new PdfOpenError('corrupt', 'PDF 文件损坏或结构无效，无法打开。', error);
  }
  return new PdfOpenError('initialization', 'PDF.js 初始化失败，无法打开该 PDF。', error);
}
