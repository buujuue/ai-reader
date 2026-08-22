import {
  EPUB_FIXTURES,
  findEpubFixture,
  type EpubFixtureDefinition,
  type EpubFixtureFeature,
} from './epubFixtureContract';
import { listZipEntries, readZipEntry } from '../../../domain/library/epub/zip';

interface FixtureZipEntry {
  name: string;
  data: Uint8Array;
  compression?: 'stored' | 'deflate';
  /** 恶意压缩包用虚假的中央目录大小验证“先预算、后解压”。 */
  declaredUncompressedSize?: number;
}

const textEncoder = new TextEncoder();

/**
 * 生成验收样书的确定性字节内容。
 *
 * 夹具只使用项目自己生成的最小内容，不包含第三方电子书正文或版权不明
 * 的二进制。所有 ZIP 字段固定为零时间戳，便于跨平台比较哈希和基准结果。
 */
export async function buildEpubFixture(id: string): Promise<Uint8Array> {
  const definition = findEpubFixture(id);
  const bytes = await buildFixtureArchive(definition);
  return definition.features.includes('corrupt-package')
    ? bytes.slice(0, Math.max(0, bytes.length - 13))
    : bytes;
}

/**
 * 构造用于范围读取回归的确定性大型 EPUB。
 * 正文章节保持很小,把 10 MiB 惰性资源放在包尾,这样打开和章节切换若
 * 退化为整包读取会被 Source 读取统计立即捕获。
 */
export async function buildLargeEpubFixture(): Promise<Uint8Array> {
  const padding = new Uint8Array(10 * 1024 * 1024);
  padding.fill(0x61);
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="large-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>大型范围读取 EPUB</dc:title><dc:language>zh</dc:language></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="padding" href="assets/padding.bin" media-type="application/octet-stream"/>
    <item id="image" href="images/pixel.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="chapter1"/><itemref idref="chapter2"/></spine>
</package>`;
  return buildZip([
    { name: 'mimetype', data: encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: encode(containerXml()) },
    { name: 'OEBPS/content.opf', data: encode(opf) },
    {
      name: 'OEBPS/nav.xhtml',
      data: encode('<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li><a href="chapter1.xhtml">第一章</a></li><li><a href="chapter2.xhtml">第二章</a></li></ol></nav></body></html>'),
    },
    {
      name: 'OEBPS/chapter1.xhtml',
      data: encode('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><img src="images/pixel.png" alt="性能夹具图片"/><p>首屏内容。</p></body></html>'),
    },
    {
      name: 'OEBPS/chapter2.xhtml',
      data: encode('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1><p>章节切换内容。</p></body></html>'),
    },
    { name: 'OEBPS/images/pixel.png', data: ONE_PIXEL_PNG },
    { name: 'OEBPS/assets/padding.bin', data: padding },
  ]);
}

export async function buildAllEpubFixtures(): Promise<
  ReadonlyMap<string, Uint8Array>
> {
  const entries = await Promise.all(
    EPUB_FIXTURES.map(async (definition) => [
      definition.id,
      await buildEpubFixture(definition.id),
    ] as const),
  );
  return new Map(entries);
}

async function buildFixtureArchive(definition: EpubFixtureDefinition): Promise<Uint8Array> {
  const features = new Set(definition.features);
  const chapter = chapterXhtml(features, definition);
  const opf = opfXml(features, definition);
  const entries: FixtureZipEntry[] = [
    { name: 'mimetype', data: encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: encode(containerXml()) },
    { name: 'OEBPS/content.opf', data: encode(opf) },
    { name: 'OEBPS/chapter.xhtml', data: encode(chapter), compression: 'deflate' },
  ];

  if (features.has('nav')) {
    entries.push({
      name: 'OEBPS/nav.xhtml',
      data: encode(navXhtml(features.has('corrupt-toc'))),
    });
  }
  if (features.has('ncx')) {
    entries.push({ name: 'OEBPS/toc.ncx', data: encode(ncxXml()) });
  }
  if (features.has('image')) {
    entries.push({ name: 'OEBPS/images/pixel.png', data: ONE_PIXEL_PNG });
  }
  if (features.has('svg')) {
    entries.push({ name: 'OEBPS/images/figure.svg', data: encode(svgImage()) });
  }
  if (features.has('obfuscated-font')) {
    entries.push({
      name: 'OEBPS/fonts/obfuscated.woff',
      data: OBFUSCATED_WOFF,
    });
  }
  if (features.has('audio-video')) {
    entries.push({ name: 'OEBPS/media/audio.mp3', data: Uint8Array.of(0) });
    entries.push({ name: 'OEBPS/media/video.mp4', data: Uint8Array.of(0) });
  }
  if (features.has('scripted-content')) {
    entries.push({ name: 'OEBPS/script.js', data: encode('function runBookCode() {}') });
  }
  if (features.has('commercial-drm')) {
    entries.push({ name: 'META-INF/rights.xml', data: encode('<rights/>') });
    entries.push({
      name: 'META-INF/encryption.xml',
      data: encode('<encryption><EncryptedData/></encryption>'),
    });
  }
  if (features.has('entry-count-limit')) {
    for (let index = entries.length; index <= 10_000; index += 1) {
      entries.push({ name: `OEBPS/assets/entry-${index}.bin`, data: Uint8Array.of(0) });
    }
  }
  if (features.has('compression-ratio-limit') || features.has('chapter-size-limit')) {
    entries.push({
      name: 'OEBPS/assets/budget-marker.txt',
      data: repeatedBytes('budget-marker-', 512 * 1024),
      compression: 'deflate',
      ...(features.has('zip-bomb')
        ? { declaredUncompressedSize: 256 * 1024 * 1024 + 1 }
        : {}),
    });
  }

  return buildZip(entries);
}

function opfXml(features: Set<EpubFixtureFeature>, definition: EpubFixtureDefinition): string {
  const epubVersion = features.has('epub2') ? '2.0' : '3.0';
  const spineDirection = features.has('rtl')
    ? ' page-progression-direction="rtl"'
    : '';
  const layout = features.has('fixed-layout')
    ? '<meta property="rendition:layout">pre-paginated</meta>'
    : '';
  const mediaItems = features.has('audio-video')
    ? '<item id="audio" href="media/audio.mp3" media-type="audio/mpeg"/><item id="video" href="media/video.mp4" media-type="video/mp4"/>'
    : '';
  const navItem = features.has('nav')
    ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    : '';
  const ncxItem = features.has('ncx')
    ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    : '';
  const scriptItem = features.has('scripted-content')
    ? '<item id="script" href="script.js" media-type="text/javascript"/>'
    : '';
  const fontItem = features.has('obfuscated-font')
    ? '<item id="font" href="fonts/obfuscated.woff" media-type="font/woff"/>'
    : '';
  const imageItems = features.has('image')
    ? '<item id="image" href="images/pixel.png" media-type="image/png"/>'
    : '';
  const svgItem = features.has('svg')
    ? '<item id="svg" href="images/figure.svg" media-type="image/svg+xml"/>'
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:rendition="http://www.idpf.org/vocab/rendition/#" version="${epubVersion}" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeXml(definition.label)}</dc:title>
    <dc:creator>AI Reader fixture generator</dc:creator>
    <dc:language>zh</dc:language>
    ${layout}
  </metadata>
  <manifest>
    ${navItem}${ncxItem}
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    ${imageItems}${svgItem}${fontItem}${mediaItems}${scriptItem}
  </manifest>
  <spine${spineDirection}${features.has('ncx') ? ' toc="ncx"' : ''}>
    <itemref idref="chapter"/>
  </spine>
</package>`;
}

function chapterXhtml(
  features: Set<EpubFixtureFeature>,
  definition: EpubFixtureDefinition,
): string {
  const style = features.has('vertical')
    ? '<style>body { writing-mode: vertical-rl; }</style>'
    : '';
  const embeddedFont = features.has('obfuscated-font')
    ? '<style>@font-face { font-family: obfuscated; src: url("fonts/obfuscated.woff") format("woff"); } body { font-family: obfuscated, sans-serif; }</style>'
    : '';
  const image = features.has('image')
    ? '<img src="images/pixel.png" alt="测试图片" />'
    : '';
  const svg = features.has('svg')
    ? '<img src="images/figure.svg" alt="测试 SVG" />'
    : '';
  const footnote = features.has('footnote')
    ? '<p>正文<sup><a href="#note-1" epub:type="noteref">[1]</a></sup></p><aside id="note-1" epub:type="footnote">脚注内容</aside>'
    : '';
  const mathml = features.has('mathml')
    ? '<p><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><mo>=</mo><mn>1</mn></math></p>'
    : '';
  const media = features.has('audio-video')
    ? '<audio src="media/audio.mp3" controls="controls"/><video src="media/video.mp4" controls="controls"/>'
    : '';
  const script = features.has('scripted-content')
    ? '<script src="script.js"/><button onclick="runBookCode()">互动</button>'
    : '';
  const remote = features.has('remote-active-resource')
    ? '<link rel="stylesheet" href="https://example.invalid/remote.css"/><style>@font-face{font-family:remote;src:url("https://example.invalid/remote.woff")}</style><script src="https://example.invalid/remote.js"/><iframe src="https://example.invalid/remote.xhtml"/><img src="https://example.invalid/remote.png"/>'
    : '';
  const depth = features.has('xml-depth-limit')
    ? `${'<div>'.repeat(65)}深层内容${'</div>'.repeat(65)}`
    : '';
  const large = features.has('chapter-size-limit')
    ? `<p>${'大章节内容。'.repeat(900_000)}</p>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${escapeXml(definition.label)}</title>${style}${embeddedFont}</head>
  <body><h1>${escapeXml(definition.label)}</h1><p>这是由项目生成器创建的最小验收正文。</p>
    ${image}${svg}${footnote}${mathml}${media}${script}${remote}${depth}${large}
  </body>
</html>`;
}

function navXhtml(corrupt: boolean): string {
  if (corrupt) {
    return '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li><a href="chapter.xhtml">损坏目录';
  }
  return '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>';
}

function ncxXml(): string {
  return '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="chapter"><navLabel><text>第一章</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>';
}

function containerXml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
}

function svgImage(): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="black"/></svg>';
}

function repeatedBytes(prefix: string, targetLength: number): Uint8Array {
  const unit = encode(prefix.repeat(16));
  const result = new Uint8Array(targetLength);
  for (let offset = 0; offset < result.length; offset += unit.length) {
    result.set(unit.subarray(0, Math.min(unit.length, result.length - offset)), offset);
  }
  return result;
}

function encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

async function buildZip(entries: FixtureZipEntry[]): Promise<Uint8Array> {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encode(entry.name);
    const uncompressed = entry.data;
    const compressed = entry.compression === 'deflate'
      ? await deflateRaw(uncompressed)
      : uncompressed;
    const method = entry.compression === 'deflate' ? 8 : 0;
    const crc = crc32(uncompressed);
    const local = new Uint8Array(30 + name.length + compressed.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(
      22,
      entry.declaredUncompressedSize ?? uncompressed.length,
      true,
    );
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(compressed, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.length, true);
    centralView.setUint32(
      24,
      entry.declaredUncompressedSize ?? uncompressed.length,
      true,
    );
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const centralDirectory = concat(centralParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralDirectory.length, true);
  eocdView.setUint32(16, offset, true);
  return concat([...localParts, centralDirectory, eocd]);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  const read = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  })();
  await writer.write(data as unknown as BufferSource);
  await writer.close();
  await read;
  return concat(chunks);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const ONE_PIXEL_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0),
);

/** 最小确定性 WOFF 头；内容故意不是可用字体，模拟混淆字体回退。 */
const OBFUSCATED_WOFF = Uint8Array.from([
  0x77, 0x4f, 0x46, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2c,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** 从真实 ZIP 中读取中央目录预算，供契约测试验证预检输入。 */
export async function measureEpubFixtureResources(
  bytes: Uint8Array,
): Promise<import('./epubFixtureContract').EpubResourceProfile> {
  const entries = listZipEntries(bytes);
  const xmlEntries = entries.filter((entry) => /\.(?:xhtml|html|xml|ncx)$/i.test(entry.name));
  let maxXmlNestingDepth = 0;
  for (const entry of xmlEntries) {
    const data = await readZipEntry(bytes, entry.name);
    if (data) {
      maxXmlNestingDepth = Math.max(
        maxXmlNestingDepth,
        measureXmlNestingDepth(new TextDecoder().decode(data)),
      );
    }
  }
  const chapterEntries = entries.filter((entry) => /\/chapter\.(?:xhtml|html)$/i.test(entry.name));
  return {
    singleEntryUncompressedBytes: Math.max(
      ...entries.map((entry) => entry.uncompressedSize),
    ),
    totalUncompressedBytes: entries.reduce(
      (total, entry) => total + entry.uncompressedSize,
      0,
    ),
    compressionRatio: Math.max(
      ...entries.map((entry) =>
        entry.compressedSize === 0
          ? Number.POSITIVE_INFINITY
          : entry.uncompressedSize / entry.compressedSize,
      ),
    ),
    largestChapterUncompressedBytes: Math.max(
      0,
      ...chapterEntries.map((entry) => entry.uncompressedSize),
    ),
    entryCount: entries.length,
    maxXmlNestingDepth,
  };
}

function measureXmlNestingDepth(xml: string): number {
  const tagPattern = /<\s*(\/?)\s*[A-Za-z][^<>]*?(\/?)\s*>/g;
  let depth = 0;
  let maximum = 0;
  for (const match of xml.matchAll(tagPattern)) {
    const closing = match[1] === '/';
    const selfClosing = match[2] === '/';
    if (closing) {
      depth = Math.max(0, depth - 1);
    } else if (!selfClosing) {
      depth += 1;
      maximum = Math.max(maximum, depth);
    }
  }
  return maximum;
}
