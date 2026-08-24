/**
 * 只用于范围读取性能验收的确定性 PDF 生成器。
 * 文件包含可渲染的多页正文和一个未引用的 80 MiB 尾部流;第二页正文对象
 * 放在该流之后,用于检测文档信息/首屏/翻页阶段是否错误复制整本 PDF。
 */

const encoder = new TextEncoder();

export interface LargePdfFixtureOptions {
  pageCount?: number;
  paddingBytes?: number;
}

export function buildLargePdfFixture(options: LargePdfFixtureOptions = {}): Uint8Array {
  const pageCount = options.pageCount ?? 12;
  const paddingBytes = options.paddingBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error(`PDF 性能夹具页数无效:${pageCount}`);
  }
  if (!Number.isSafeInteger(paddingBytes) || paddingBytes < 0) {
    throw new Error(`PDF 性能夹具填充大小无效:${paddingBytes}`);
  }

  const firstPageObject = 3;
  const firstContentObject = firstPageObject + pageCount;
  const fontObject = firstContentObject + pageCount;
  const prefixPaddingObject = fontObject + 1;
  const paddingObject = prefixPaddingObject + 1;
  const objectCount = paddingObject;
  const objects = new Map<number, Uint8Array>();

  objects.set(1, objectBytes(1, '<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(
    2,
    objectBytes(
      2,
      `<< /Type /Pages /Kids [${Array.from(
        { length: pageCount },
        (_, index) => `${firstPageObject + index} 0 R`,
      ).join(' ')}] /Count ${pageCount} >>`,
    ),
  );

  for (let index = 0; index < pageCount; index += 1) {
    const pageObject = firstPageObject + index;
    const contentObject = firstContentObject + index;
    objects.set(
      pageObject,
      objectBytes(
        pageObject,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObject} 0 R /Resources << /Font << /F1 ${fontObject} 0 R >> >> >>`,
      ),
    );
    const text = `BT /F1 18 Tf 72 720 Td (AI Reader performance page ${index + 1}) Tj ET`;
    objects.set(contentObject, streamObjectBytes(contentObject, encoder.encode(text)));
  }

  objects.set(fontObject, objectBytes(fontObject, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  const prefixPadding = new Uint8Array(256 * 1024);
  prefixPadding.fill(0x31);
  objects.set(prefixPaddingObject, streamObjectBytes(prefixPaddingObject, prefixPadding));
  const padding = new Uint8Array(paddingBytes);
  padding.fill(0x30);
  objects.set(paddingObject, streamObjectBytes(paddingObject, padding));

  const header = Uint8Array.from([
    ...encoder.encode('%PDF-1.7\n%'),
    0xff,
    0xff,
    0xff,
    0xff,
    0x0a,
  ]);
  const chunks: Uint8Array[] = [header];
  const offsets = new Array<number>(objectCount + 1).fill(0);
  let cursor = header.byteLength;
  const objectOrder = [
    1,
    2,
    ...Array.from({ length: pageCount }, (_, index) => firstPageObject + index),
    firstContentObject,
    fontObject,
    prefixPaddingObject,
    paddingObject,
    ...Array.from(
      { length: Math.max(0, pageCount - 1) },
      (_, index) => firstContentObject + index + 1,
    ),
  ];
  for (const number of objectOrder) {
    const object = objects.get(number);
    if (!object) throw new Error(`PDF 性能夹具缺少对象:${number}`);
    offsets[number] = cursor;
    chunks.push(object);
    cursor += object.byteLength;
  }

  const xref = [
    `xref\n0 ${objectCount + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`,
  ];
  chunks.push(encoder.encode(xref.join('')));
  return concat(chunks);
}

function objectBytes(number: number, body: string): Uint8Array {
  return encoder.encode(`${number} 0 obj\n${body}\nendobj\n`);
}

function streamObjectBytes(number: number, data: Uint8Array): Uint8Array {
  return concat([
    encoder.encode(`${number} 0 obj\n<< /Length ${data.byteLength} >>\nstream\n`),
    data,
    encoder.encode('\nendstream\nendobj\n'),
  ]);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
