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

  it('允许 EPUB XHTML 使用安全的 HTML5 DOCTYPE', async () => {
    const epub = buildStoredZip([
      { name: 'META-INF/container.xml', data: encode(containerXml()) },
      { name: 'OEBPS/content.opf', data: encode(opfXml({})) },
      {
        name: 'OEBPS/chapter1.xhtml',
        data: encode('<!DOCTYPE html><html><body><p>正文</p></body></html>'),
      },
      {
        name: 'OEBPS/chapter2.xhtml',
        data: encode('<html><body><p>第二章</p></body></html>'),
      },
      {
        name: 'OEBPS/nav.xhtml',
        data: encode('<html><body><nav><ol><li><a href="chapter1.xhtml">正文</a></li></ol></nav></body></html>'),
      },
    ]);

    const result = await inspectEpub(epub);

    expect(result.metadata.title).toBe('预检书');
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

  it('缺少 spine 或首个可读章节时拒绝整本书', async () => {
    const withoutSpine = buildStoredZip([
      { name: 'META-INF/container.xml', data: encode(containerXml()) },
      {
        name: 'OEBPS/content.opf',
        data: encode(opfXml({ spine: null })),
      },
    ]);

    const spineError = await inspectEpub(withoutSpine).catch((caught) => caught);
    expect((spineError as EpubInspectError).kind).toBe('corrupt');

    const withoutChapter = buildStoredZip([
      { name: 'META-INF/container.xml', data: encode(containerXml()) },
      {
        name: 'OEBPS/content.opf',
        data: encode(opfXml({ spine: '<itemref idref="missing"/>' })),
      },
    ]);

    const chapterError = await inspectEpub(withoutChapter).catch((caught) => caught);
    expect((chapterError as EpubInspectError).kind).toBe('corrupt');
  });

  it('首个章节超出预算时拒绝整本书', async () => {
    const epub = buildBudgetedEpub({
      chapter1: { declaredUncompressedSize: 8 * 1024 * 1024 + 1 },
    });

    const error = await inspectEpub(epub).catch((caught) => caught);

    expect(error).toBeInstanceOf(EpubInspectError);
    expect((error as EpubInspectError).kind).toBe('budget');
    expect((error as EpubInspectError).message).toMatch(/章节/);
  });

  it('非首个章节超出预算时保留书籍并标记章节不可用', async () => {
    const epub = buildBudgetedEpub({
      chapter2: { declaredUncompressedSize: 8 * 1024 * 1024 + 1 },
    });

    const result = await inspectEpub(epub);

    expect(result.preflight.unavailableChapters).toEqual([
      expect.objectContaining({ spineIndex: 1, path: 'OEBPS/chapter2.xhtml' }),
    ]);
  });

  it('图片超出条目预算时局部降级而不是拒绝整书', async () => {
    const epub = buildBudgetedEpub({
      extraEntries: [
        {
          name: 'OEBPS/images/large.png',
          data: encode('not actually large'),
          declaredUncompressedSize: 64 * 1024 * 1024 + 1,
        },
      ],
      extraManifest: '<item id="large-image" href="images/large.png" media-type="image/png"/>',
    });

    const result = await inspectEpub(epub);

    expect(result.preflight.degradedResources).toEqual([
      expect.objectContaining({
        path: 'OEBPS/images/large.png',
        category: 'image',
        reason: 'budget',
      }),
    ]);
  });

  it('损坏或超限的 NAV/NCX 只降级目录能力', async () => {
    const epub = buildBudgetedEpub({
      navData: encode('<html><body><nav>损坏'),
    });

    const result = await inspectEpub(epub);

    expect(result.metadata.title).toBe('预检书');
    expect(result.preflight.navigation).toEqual(
      expect.objectContaining({ state: 'degraded', source: 'nav' }),
    );
  });

  it('商业 DRM 被稳定归类为 drm', async () => {
    const epub = buildBudgetedEpub({
      extraEntries: [
        { name: 'META-INF/rights.xml', data: encode('<rights/>') },
        {
          name: 'META-INF/encryption.xml',
          data: encode(
            '<encryption><EncryptedData><EncryptionMethod Algorithm="urn:example:drm"/><CipherReference URI="OEBPS/chapter1.xhtml"/></EncryptedData></encryption>',
          ),
        },
      ],
    });

    const error = await inspectEpub(epub).catch((caught) => caught);

    expect((error as EpubInspectError).kind).toBe('drm');
    expect((error as EpubInspectError).message).toMatch(/DRM/);
  });

  it('标准字体混淆不会被误判为商业 DRM', async () => {
    const epub = buildBudgetedEpub({
      extraManifest: '<item id="font" href="fonts/font.woff" media-type="font/woff"/>',
      extraEntries: [
        { name: 'OEBPS/fonts/font.woff', data: encode('font') },
        {
          name: 'META-INF/encryption.xml',
          data: encode(
            '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherReference URI="OEBPS/fonts/font.woff"/></EncryptedData></encryption>',
          ),
        },
      ],
    });

    const result = await inspectEpub(epub);

    expect(result.metadata.title).toBe('预检书');
  });
});

function containerXml(): string {
  return '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
}

function opfXml(options: { spine?: string | null; extraManifest?: string }): string {
  const spine = options.spine === null
    ? ''
    : `<spine>${options.spine ?? '<itemref idref="chapter1"/><itemref idref="chapter2"/>'}</spine>`;
  return `<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>预检书</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>${options.extraManifest ?? ''}</manifest>${spine}</package>`;
}

function buildBudgetedEpub(options: {
  chapter1?: { declaredUncompressedSize?: number };
  chapter2?: { declaredUncompressedSize?: number };
  extraManifest?: string;
  extraEntries?: Array<{
    name: string;
    data: Uint8Array;
    declaredUncompressedSize?: number;
  }>;
  navData?: Uint8Array;
} = {}): Uint8Array {
  return buildStoredZip([
    { name: 'META-INF/container.xml', data: encode(containerXml()) },
    {
      name: 'OEBPS/content.opf',
      data: encode(opfXml({ extraManifest: options.extraManifest ?? '' })),
    },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: encode('<html><body><h1>第一章</h1><p>正文</p></body></html>'),
      ...options.chapter1,
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: encode('<html><body><h1>第二章</h1><p>正文</p></body></html>'),
      ...options.chapter2,
    },
    {
      name: 'OEBPS/nav.xhtml',
      data: options.navData ?? encode('<html><body><nav><ol><li><a href="chapter1.xhtml">第一章</a></li></ol></nav></body></html>'),
    },
    ...(options.extraEntries ?? []),
  ]);
}
