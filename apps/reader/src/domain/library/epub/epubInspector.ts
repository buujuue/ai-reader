import { readZipEntry } from './zip';
import type { SourceMetadata } from '../material';

/** 领域化错误:文件不是有效 EPUB 或结构损坏时抛出,前端据此展示可读文案。 */
export class EpubInspectError extends Error {
  override name = 'EpubInspectError';
}

export interface EpubInspectResult {
  metadata: SourceMetadata;
  /** 是否在清单中检测到封面条目。封面二进制持久化属于后续切片。 */
  hasCover: boolean;
}

function elementsByLocalName(doc: Document, localName: string): Element[] {
  return Array.from(doc.getElementsByTagNameNS('*', localName));
}

function parseXml(bytes: Uint8Array, label: string): Document {
  const xml = new TextDecoder('utf-8').decode(bytes);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parserError = elementsByLocalName(doc, 'parsererror')[0];
  if (parserError) {
    throw new EpubInspectError(`${label}不是有效的 XML`);
  }
  return doc;
}

function firstText(doc: Document, localName: string): string | null {
  const element = elementsByLocalName(doc, localName)[0];
  const text = element?.textContent?.trim();
  return text ? text : null;
}

/**
 * 检查一份 EPUB 字节内容,提取来源元数据与封面存在性。
 * 这是 BookDocument 的雏形:只解析容器与清单,不接触渲染器。
 */
export async function inspectEpub(bytes: Uint8Array): Promise<EpubInspectResult> {
  try {
    return await inspectEpubInner(bytes);
  } catch (error) {
    if (error instanceof EpubInspectError) {
      throw error;
    }
    throw new EpubInspectError('无法解析 EPUB 文件结构');
  }
}

async function inspectEpubInner(bytes: Uint8Array): Promise<EpubInspectResult> {
  const containerXml = await readZipEntry(bytes, 'META-INF/container.xml');
  if (!containerXml) {
    throw new EpubInspectError('缺少 META-INF/container.xml,不是有效的 EPUB');
  }
  const container = parseXml(containerXml, 'container.xml');
  const rootfile = elementsByLocalName(container, 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) {
    throw new EpubInspectError('container.xml 未声明 OPF 清单路径');
  }

  const opfXml = await readZipEntry(bytes, normalizePath(opfPath));
  if (!opfXml) {
    throw new EpubInspectError(`缺少 OPF 清单文件:${opfPath}`);
  }
  const opf = parseXml(opfXml, 'OPF 清单');

  const title = firstText(opf, 'title');
  if (!title) {
    throw new EpubInspectError('EPUB 缺少书名(title)');
  }

  const metadata: SourceMetadata = {
    title,
    author: firstText(opf, 'creator'),
    language: firstText(opf, 'language'),
  };
  const hasCover = detectCover(opf);

  return { metadata, hasCover };
}

function detectCover(opf: Document): boolean {
  const coverMeta = elementsByLocalName(opf, 'meta').find(
    (element) => element.getAttribute('name') === 'cover',
  );
  const coverId = coverMeta?.getAttribute('content');

  return elementsByLocalName(opf, 'item').some((item) => {
    const properties = item.getAttribute('properties') ?? '';
    return (
      (coverId !== undefined && item.getAttribute('id') === coverId && coverId !== null) ||
      properties.split(/\s+/).includes('cover-image')
    );
  });
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}