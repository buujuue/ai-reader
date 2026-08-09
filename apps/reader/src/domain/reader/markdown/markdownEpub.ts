/**
 * Markdown → 内存 EPUB 构造器。
 *
 * ADR-0004 / ADR-0009:Markdown 阅读模式复用统一 BookDocument 与 Foliate View。
 * 这里把按一级标题切分、已清洗的章节组装成一份最小的内存 EPUB(仅 stored 压缩),
 * 交给 Foliate 分页器渲染,从而复用既有分页、搜索、目录、导航与排版能力。
 *
 * 本模块自带最小 stored-zip 写入器,保持 `domain/reader` 不依赖 `domain/library`。
 * 章节内容在进入前已经 `sanitizeHtmlFragment` 清洗(ADR-0010)。
 */

import type { BookDocumentMetadata } from '../bookDocument';
import type { ParsedMarkdown } from './markdownParser';

/** EPUB 里一个章节的 href(相对 OEBPS 根)。 */
export interface MarkdownEpubOptions {
  metadata: BookDocumentMetadata;
  parsed: ParsedMarkdown;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 把章节标题转成安全的锚点 id(去空白与非法字符)。 */
function anchorId(index: number): string {
  return `md-section-${index + 1}`;
}

function sectionHref(index: number): string {
  return `section${index + 1}.xhtml`;
}

function buildXhtml(title: string, bodyHtml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(title)}</title></head>
<body>${bodyHtml}</body>
</html>`;
}

function buildNav(parsed: ParsedMarkdown): string {
  const items = parsed.sections
    .map(
      (section, index) =>
        `<li><a href="${sectionHref(index)}#${anchorId(index)}">${escapeXml(
          section.title || `第 ${index + 1} 节`,
        )}</a></li>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>${items}</ol></nav></body>
</html>`;
}

function buildOpf(parsed: ParsedMarkdown, metadata: BookDocumentMetadata): string {
  const items = parsed.sections
    .map(
      (section, index) =>
        `<item id="s${index + 1}" href="${sectionHref(index)}" media-type="application/xhtml+xml"/>`,
    )
    .join('\n');
  const itemrefs = parsed.sections
    .map((_, index) => `<itemref idref="s${index + 1}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="md-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="md-id">md:${anchorId(0)}</dc:identifier>
    <dc:title>${escapeXml(metadata.title)}</dc:title>
    ${metadata.author ? `<dc:creator>${escapeXml(metadata.author)}</dc:creator>` : ''}
    ${metadata.language ? `<dc:language>${escapeXml(metadata.language)}</dc:language>` : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${items}
  </manifest>
  <spine>
    ${itemrefs}
  </spine>
</package>`;
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

/**
 * 组装一份内存 EPUB 字节。章节内容必须已经清洗。
 * `index` 为章节序号,用于构造稳定的锚点 id 与 href。
 */
export function buildMarkdownEpub(options: MarkdownEpubOptions): Uint8Array {
  const { parsed, metadata } = options;
  const entries: Array<{ name: string; data: Uint8Array }> = [
    { name: 'mimetype', data: encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: encode(containerXml()) },
    { name: 'OEBPS/content.opf', data: encode(buildOpf(parsed, metadata)) },
    { name: 'OEBPS/nav.xhtml', data: encode(buildNav(parsed)) },
    ...parsed.sections.map((section, index) => {
      const html = buildXhtml(
        section.title || `第 ${index + 1} 节`,
        `<section id="${anchorId(index)}">${section.html}</section>`,
      );
      return { name: `OEBPS/${sectionHref(index)}`, data: encode(html) };
    }),
  ];
  return buildStoredZip(entries);
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 最小 stored(不压缩)ZIP 写入器,满足极小内存 EPUB 的读取需求。 */
export function buildStoredZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
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