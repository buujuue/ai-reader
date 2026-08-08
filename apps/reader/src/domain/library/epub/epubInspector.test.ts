import { describe, expect, it } from 'vitest';

import { EpubInspectError, inspectEpub } from './epubInspector';
import { buildDeflatedEpub, buildEpub, buildStoredZip, encode } from './testEpub';

describe('EpubInspector', () => {
  it('从有效 EPUB 提取标题、作者与语言', async () => {
    const epub = buildEpub({ title: '示例书', author: '作者', language: 'zh' });

    const result = await inspectEpub(epub);

    expect(result.metadata).toEqual({ title: '示例书', author: '作者', language: 'zh' });
  });

  it('支持 deflate 压缩条目', async () => {
    const epub = await buildDeflatedEpub();

    const result = await inspectEpub(epub);

    expect(result.metadata.title).toBe('压缩书');
  });

  it('缺失的作者与语言以 null 表达', async () => {
    const epub = buildEpub({ title: '无作者书' });

    const result = await inspectEpub(epub);

    expect(result.metadata).toEqual({ title: '无作者书', author: null, language: null });
  });

  it('检测到封面条目时返回 hasCover=true', async () => {
    const epub = buildEpub({ title: '带封面', withCover: true });

    const result = await inspectEpub(epub);

    expect(result.hasCover).toBe(true);
  });

  it('无封面条目时返回 hasCover=false', async () => {
    const epub = buildEpub({ title: '无封面' });

    const result = await inspectEpub(epub);

    expect(result.hasCover).toBe(false);
  });

  it('缺少 container.xml 时抛出领域化错误', async () => {
    const zip = buildStoredZip([{ name: 'mimetype', data: encode('x') }]);

    await expect(inspectEpub(zip)).rejects.toBeInstanceOf(EpubInspectError);
  });

  it('container.xml 未声明 OPF 时抛出领域化错误', async () => {
    const zip = buildStoredZip([
      {
        name: 'META-INF/container.xml',
        data: encode('<?xml version="1.0"?><container><rootfiles/></container>'),
      },
    ]);

    await expect(inspectEpub(zip)).rejects.toBeInstanceOf(EpubInspectError);
  });

  it('OPF 缺少书名时抛出领域化错误', async () => {
    const zip = buildStoredZip([
      {
        name: 'META-INF/container.xml',
        data: encode(
          '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        ),
      },
      {
        name: 'OEBPS/content.opf',
        data: encode(
          '<package xmlns="http://www.idpf.org/2007/opf"><metadata/></package>',
        ),
      },
    ]);

    await expect(inspectEpub(zip)).rejects.toBeInstanceOf(EpubInspectError);
  });

  it('不是 ZIP 文件时抛出领域化错误', async () => {
    await expect(inspectEpub(encode('not a zip at all'))).rejects.toBeInstanceOf(
      EpubInspectError,
    );
  });

  it('空字节归类为 empty 并给出可行动的文案', async () => {
    const error = await inspectEpub(new Uint8Array(0)).catch((caught) => caught);

    expect(error).toBeInstanceOf(EpubInspectError);
    expect((error as EpubInspectError).kind).toBe('empty');
    expect((error as EpubInspectError).message).toMatch(/为空/);
  });

  it('非 ZIP 字节归类为 unsupported', async () => {
    const error = await inspectEpub(encode('not a zip at all')).catch((caught) => caught);

    expect((error as EpubInspectError).kind).toBe('unsupported');
  });

  it('结构损坏的 EPUB 归类为 corrupt', async () => {
    const zip = buildStoredZip([
      {
        name: 'META-INF/container.xml',
        data: encode('<?xml version="1.0"?><container><rootfiles/></container>'),
      },
    ]);

    const error = await inspectEpub(zip).catch((caught) => caught);

    expect((error as EpubInspectError).kind).toBe('corrupt');
  });

  it('截断的 ZIP 归类为 corrupt', async () => {
    const epub = buildEpub({ title: '甲' });
    const truncated = epub.slice(0, Math.floor(epub.length / 2));

    const error = await inspectEpub(truncated).catch((caught) => caught);

    expect((error as EpubInspectError).kind).toBe('corrupt');
  });
});