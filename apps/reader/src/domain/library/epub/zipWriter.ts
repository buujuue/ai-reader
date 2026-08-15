/**
 * ZIP/EPUB 字节构造器。仅用于测试夹具与浏览器降级开发的演示材料,
 * 不属于阅读领域核心能力。
 */
export interface TestZipEntry {
  name: string;
  data: Uint8Array;
}

export function buildStoredZip(entries: TestZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);

    const local = new Uint8Array(30 + nameBytes.length + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    chunks.push(local);

    const centralEntry = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralEntry.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    centralEntry.set(nameBytes, 46);
    central.push(centralEntry);

    offset += local.length;
  }

  const centralBytes = concat(central);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralBytes.length, true);
  eocdView.setUint32(16, offset, true);

  return concat([...chunks, centralBytes, eocd]);
}

export function buildEpub(options: {
  title: string;
  author?: string;
  language?: string;
  withCover?: boolean;
  withImage?: boolean;
}): Uint8Array {
  const withImage = options.withImage ?? false;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${options.title}</dc:title>
    ${options.author ? `<dc:creator>${options.author}</dc:creator>` : ''}
    ${options.language ? `<dc:language>${options.language}</dc:language>` : ''}
    ${options.withCover ? '<meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    ${options.withCover ? '<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>' : ''}
    ${withImage ? '<item id="body-image" href="images/body.png" media-type="image/png"/>' : ''}
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>`;

  return buildStoredZip([
    { name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: encode(containerXml()) },
    { name: 'OEBPS/content.opf', data: encode(opf) },
    {
      name: 'OEBPS/nav.xhtml',
      data: encode('<html><head><title>目录</title></head><body><nav><ol><li><a href="chapter1.xhtml">第一章</a></li><li><a href="chapter2.xhtml">第二章</a></li></ol></nav></body></html>'),
    },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: encode(
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章</h1>${withImage ? '<img src="images/body.png" alt="测试图片"/><p data-image-marker="body-image">这是第一章的正文内容,用于验证真实渲染。</p>' : '<p>这是第一章的正文内容,用于验证真实渲染。</p>'}</body></html>`,
      ),
    },
      {
        name: 'OEBPS/chapter2.xhtml',
        data: encode(
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章</h1><p>这是第二章的正文内容,用于验证翻页。</p></body></html>',
        ),
      },
      ...(options.withCover ? [{ name: 'OEBPS/images/cover.png', data: ONE_PIXEL_PNG }] : []),
      ...(withImage ? [{ name: 'OEBPS/images/body.png', data: ONE_PIXEL_PNG }] : []),
    ]);
}

/** 最小有效 PNG,供真实 EPUB 渲染冒烟测试验证包内图片资源链路。 */
const ONE_PIXEL_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (char) => char.charCodeAt(0),
);

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
