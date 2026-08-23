import { describe, expect, it, vi } from 'vitest';

import { ManagedFileSource } from '../../library/managedFileSource';
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
    expect(result.sourceCover).toBeNull();
  });

  it('检查阶段渲染首页来源封面,不依赖文字层且在销毁文档前释放页面', async () => {
    const document = makeFakeDocument(1);
    const page = (document as unknown as { pages: Array<{ cleanup: ReturnType<typeof vi.fn> }> }).pages[0]!;
    const lib = makeFakeLib(document);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['rendered-page'], { type: 'image/png' })),
    );
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 300,
      height: 400,
      close: vi.fn(),
    })));

    try {
      const result = await inspectPdf(pdfBytes(), lib);

      expect(result.sourceCover).toMatchObject({ mimeType: 'image/png' });
      expect(result.sourceCover?.bytes).toEqual(
        new Uint8Array(await new Blob(['rendered-page']).arrayBuffer()),
      );
      expect(document.getPage).toHaveBeenCalledWith(1);
      expect(page.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('首页渲染失败只产生封面降级,PDF 检查仍然成功', async () => {
    const document = makeFakeDocument(1);
    const page = (document as unknown as { pages: Array<{ render: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn> }> }).pages[0]!;
    (page.render as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      promise: Promise.resolve().then(() => {
        throw new Error('render failed');
      }),
      cancel: vi.fn(),
    }));
    const lib = makeFakeLib(document);

    const result = await inspectPdf(pdfBytes(), lib);

    expect(result.metadata.title).toBe('示例 PDF');
    expect(result.sourceCover).toBeNull();
    expect(result.coverWarning).toMatch(/封面/);
    expect(page.cleanup).toHaveBeenCalledTimes(1);
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

  it('检查阶段复用同一个 ManagedFileSource 的范围缓存,不复制整份 PDF', async () => {
    const bytes = new Uint8Array(256 * 1024);
    bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
    const readRange = vi.fn(async (offset: number, length: number) =>
      bytes.slice(offset, offset + length),
    );
    const source = new ManagedFileSource(
      { name: 'large.pdf', size: bytes.byteLength },
      readRange,
    );
    const document = makeFakeDocument(2);
    const lib = makeFakeLib(document);
    (lib.getDocument as ReturnType<typeof vi.fn>).mockImplementation((options) => {
      options.range.requestDataRange?.(0, 64);
      return { promise: Promise.resolve(document) };
    });

    await inspectPdf(source, lib);
    await inspectPdf(source, lib);

    expect((lib.getDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty('data');
    expect(readRange).toHaveBeenCalledTimes(1);
    expect(readRange.mock.calls[0]).toEqual([0, 128 * 1024]);
  });
});
