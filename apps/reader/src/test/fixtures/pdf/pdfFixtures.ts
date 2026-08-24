/**
 * 只用于范围读取性能验收的确定性 PDF 生成器。
 *
 * 每一页都有自己的、被 `/Contents` 引用的内容流；大文件体积来自真实的
 * 页面对象和内容对象，而不是未引用的尾部填充。这样 PDF.js 在解析文档、
 * 打开首屏和跳到远处页面时都会访问不同的有效 PDF 结构。
 */

const encoder = new TextEncoder();

export interface LargePdfFixtureOptions {
  pageCount?: number;
  /** 每页内容流的确定性大小,用于让文件规模随有效页面数量增长。 */
  contentBytesPerPage?: number;
}

export function buildLargePdfFixture(options: LargePdfFixtureOptions = {}): Uint8Array {
  const pageCount = options.pageCount ?? 12;
  const contentBytesPerPage = options.contentBytesPerPage ?? 16 * 1024;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error(`PDF 性能夹具页数无效:${pageCount}`);
  }
  if (!Number.isSafeInteger(contentBytesPerPage) || contentBytesPerPage < 256) {
    throw new Error(`PDF 性能夹具每页内容大小无效:${contentBytesPerPage}`);
  }

  const firstPageObject = 3;
  const firstContentObject = firstPageObject + pageCount;
  const fontObject = firstContentObject + pageCount;
  const objectCount = fontObject;
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
    objects.set(
      contentObject,
      streamObjectBytes(
        contentObject,
        buildPageContent(index, contentBytesPerPage),
      ),
    );
  }

  objects.set(
    fontObject,
    objectBytes(fontObject, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  );

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
    fontObject,
    ...Array.from({ length: pageCount }, (_, index) => [
      firstPageObject + index,
      firstContentObject + index,
    ]).flat(),
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

function buildPageContent(pageIndex: number, byteLength: number): Uint8Array {
  const visible = encoder.encode(
    `BT /F1 18 Tf 72 720 Td (AI Reader performance page ${pageIndex + 1}) Tj ET\n`,
  );
  if (visible.byteLength > byteLength) {
    throw new Error(`PDF 性能夹具每页内容太小:${byteLength}`);
  }

  const result = new Uint8Array(byteLength);
  result.fill(0x20);
  result.set(visible);
  const filler = encoder.encode(`% referenced page ${pageIndex + 1} content\n`);
  result.set(
    filler.subarray(0, Math.min(filler.byteLength, byteLength - visible.byteLength)),
    visible.byteLength,
  );
  return result;
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
