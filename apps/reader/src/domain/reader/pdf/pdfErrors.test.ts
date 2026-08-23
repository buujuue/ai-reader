import { describe, expect, it } from 'vitest';

import { PdfRangeReadError } from './pdfRangeTransport';
import { toPdfOpenError, toPdfReadError } from './pdfErrors';

describe('PDF 错误分类', () => {
  it('结构损坏属于打开阶段错误', () => {
    const error = toPdfOpenError(new Error('Invalid PDF structure'));

    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('PDF 文件损坏或结构无效');
  });

  it('已打开页面的渲染失败不误报为初始化失败', () => {
    const error = toPdfReadError(new Error('canvas render failed'));

    expect(error.kind).toBe('rendering');
    expect(error.message).toContain('页面读取或渲染失败');
    expect(error.message).not.toContain('初始化失败');
  });

  it('运行时范围失败仍保留请求区间', () => {
    const error = toPdfReadError(new PdfRangeReadError(128, 256, new Error('磁盘读取失败')));

    expect(error.kind).toBe('range');
    expect(error.message).toContain('[128,256)');
  });

  it('打开阶段和运行时范围错误共享同一条中文文案', () => {
    const cause = new PdfRangeReadError(128, 256, new Error('磁盘读取失败'));

    expect(toPdfOpenError(cause).message).toBe(toPdfReadError(cause).message);
  });
});
