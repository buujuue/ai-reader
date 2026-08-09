import { describe, expect, it, vi } from 'vitest';

import { inspectPdf, PdfInspectError } from './pdfInspector';
import { makeFakeDocument, makeFakeLib } from './pdfTestFakes';

function pdfBytes(text = '%PDF-1.7\n'): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 构造在 getDocument 阶段抛错的伪库。 */
function makeRejectingLib(): ReturnType<typeof makeFakeLib> {
  const lib = makeFakeLib(makeFakeDocument(1));
  (lib.getDocument as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    promise: Promise.reject(new Error('invalid pdf structure')),
  }));
  return lib;
}

describe('inspectPdf 错误 PDF 分类', () => {
  it('空内容抛出 empty 分类错误', async () => {
    await expect(inspectPdf(new Uint8Array())).rejects.toBeInstanceOf(PdfInspectError);
    await expect(inspectPdf(new Uint8Array())).rejects.toMatchObject({ kind: 'empty' });
  });

  it('无 PDF 头且解析失败时分类为 unsupported', async () => {
    const lib = makeRejectingLib();
    await expect(inspectPdf(pdfBytes('PK\u0003\u0004 not a zip'), lib)).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });

  it('有 PDF 头但结构损坏时分类为 corrupt', async () => {
    const lib = makeRejectingLib();
    await expect(inspectPdf(pdfBytes('%PDF-1.7 broken'), lib)).rejects.toMatchObject({
      kind: 'corrupt',
    });
  });

  it('成功解析时返回来源元数据与页数', async () => {
    const document = makeFakeDocument(3);
    const lib = makeFakeLib(document);
    (document.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
      info: { Title: '示例 PDF', Author: '示例作者' },
      metadata: null,
    });

    const result = await inspectPdf(pdfBytes(), lib);

    expect(result.pageCount).toBe(3);
    expect(result.metadata).toMatchObject({ title: '示例 PDF', author: '示例作者' });
  });

  it('多作者 dc:creator 数组归一化为「、」连接的字符串,避免 commit 序列化失败', async () => {
    const document = makeFakeDocument(2);
    const lib = makeFakeLib(document);
    (document.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
      info: {},
      metadata: {
        get: (name: string) => {
          if (name === 'dc:title') return '示例 PDF';
          if (name === 'dc:creator') return ['作者甲', '作者乙'];
          if (name === 'dc:language') return 'zh-CN';
          return null;
        },
      },
    });

    const result = await inspectPdf(pdfBytes(), lib);

    expect(result.metadata).toMatchObject({
      title: '示例 PDF',
      author: '作者甲、作者乙',
      language: 'zh-CN',
    });
  });
});