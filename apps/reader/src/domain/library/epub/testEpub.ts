/**
 * 测试用 EPUB 构造器。复用 zipWriter,并额外提供 deflate 压缩路径的夹具。
 */
export { buildEpub, buildStoredZip, encode } from './zipWriter';
export type { TestZipEntry } from './zipWriter';

/** 构造一个把 container.xml 以 deflate 压缩的 EPUB,验证解压路径。 */
export async function buildDeflatedEpub(): Promise<Uint8Array> {
  const container = encode(
    '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  return buildZipWithMethod([
    {
      name: 'META-INF/container.xml',
      data: await deflate(container),
      uncompressedSize: container.length,
    },
    {
      name: 'OEBPS/content.opf',
      data: encode(
        '<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>压缩书</dc:title></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
      ),
    },
    {
      name: 'OEBPS/chapter.xhtml',
      data: encode('<html><body><p>正文</p></body></html>'),
    },
  ]);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(data as unknown as BufferSource);
  void writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return concat(chunks);
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

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function buildZipWithMethod(
  entries: Array<{ name: string; data: Uint8Array; uncompressedSize?: number }>,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const method = entry.name === 'META-INF/container.xml' ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.uncompressedSize ?? entry.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    chunks.push(local);

    const centralEntry = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralEntry.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.uncompressedSize ?? entry.data.length, true);
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
