import {
  listZipEntries,
  readZipEntry,
  ZipBudgetError,
  ZipEncryptionError,
  ZipError,
  type ZipEntry,
} from './zip';
import { EPUB_RESOURCE_BUDGET } from './epubBudget';
import type { SourceMetadata } from '../material';

/** 导入前整本拒绝的稳定分类。 */
export type EpubInspectErrorKind =
  | 'empty'
  | 'unsupported'
  | 'corrupt'
  | 'drm'
  | 'budget';

export type EpubInspectErrorReason =
  | 'zip'
  | 'container'
  | 'opf'
  | 'spine'
  | 'first-chapter'
  | 'drm'
  | 'budget';

/** 检查失败的领域化错误；kind 与 reason 是 UI 和测试使用的稳定分类。 */
export class EpubInspectError extends Error {
  override name = 'EpubInspectError';

  constructor(
    message: string,
    readonly kind: EpubInspectErrorKind,
    readonly reason?: EpubInspectErrorReason,
  ) {
    super(message);
  }
}

export type EpubDegradationReason = 'budget' | 'corrupt' | 'unsupported';

export type EpubResourceCategory =
  | 'image'
  | 'svg'
  | 'font'
  | 'cover'
  | 'footnote'
  | 'media'
  | 'resource';

export interface EpubUnavailableChapter {
  spineIndex: number;
  path: string;
  reason: EpubDegradationReason;
}

export interface EpubDegradedResource {
  path: string;
  category: EpubResourceCategory;
  reason: EpubDegradationReason;
}

export interface EpubNavigationPreflight {
  state: 'available' | 'degraded' | 'missing';
  source: 'nav' | 'ncx' | 'none';
  reason?: EpubDegradationReason;
}

/** 预检成功后随导入结果向上层传递的局部降级报告。 */
export interface EpubPreflightReport {
  unavailableChapters: EpubUnavailableChapter[];
  degradedResources: EpubDegradedResource[];
  navigation: EpubNavigationPreflight;
}

export interface EpubInspectResult {
  metadata: SourceMetadata;
  /** 是否在清单中检测到封面条目。封面二进制持久化属于后续切片。 */
  hasCover: boolean;
  /** 结构、安全与资源预算预检报告；只有整本核心闭环可用时才会返回。 */
  preflight: EpubPreflightReport;
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
  path: string | null;
}

interface SpineItem {
  manifest: ManifestItem | null;
  path: string | null;
  linear: string;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const FONT_OBFUSCATION_ALGORITHMS = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

/**
 * 在书库状态变化前完成 EPUB 结构、安全和资源预算预检。
 * 该函数不写文件、不调用 Repository，也不把任何输入交给渲染器。
 */
export async function inspectEpub(bytes: Uint8Array): Promise<EpubInspectResult> {
  if (bytes.length === 0) {
    throw new EpubInspectError('文件内容为空,无法导入', 'empty');
  }

  let entries: ZipEntry[];
  try {
    entries = listZipEntries(bytes);
  } catch (error) {
    if (error instanceof ZipError && error.kind === 'budget') {
      throw new EpubInspectError('EPUB 资源预算超限,无法安全导入', 'budget', 'budget');
    }
    const kind = hasZipHeader(bytes) ? 'corrupt' : 'unsupported';
    throw new EpubInspectError(
      kind === 'corrupt'
        ? 'EPUB 包损坏,无法解析 ZIP 结构'
        : '不支持的文件格式:无法解析 EPUB ZIP 结构',
      kind,
      kind === 'corrupt' ? 'zip' : undefined,
    );
  }

  try {
    return await inspectEpubInner(bytes, entries);
  } catch (error) {
    if (error instanceof EpubInspectError) {
      throw error;
    }
    if (error instanceof ZipEncryptionError) {
      throw new EpubInspectError('不支持商业 DRM 或无法解密的 EPUB', 'drm', 'drm');
    }
    if (error instanceof ZipBudgetError) {
      throw new EpubInspectError('EPUB 资源预算超限,无法安全导入', 'budget', 'budget');
    }
    if (error instanceof ZipError) {
      throw new EpubInspectError('EPUB 包损坏,无法完成预检', 'corrupt', 'zip');
    }
    throw new EpubInspectError('EPUB 包损坏,无法完成结构预检', 'corrupt');
  }
}

async function inspectEpubInner(
  bytes: Uint8Array,
  entries: ZipEntry[],
): Promise<EpubInspectResult> {
  if (entries.length > EPUB_RESOURCE_BUDGET.maxEntryCount) {
    throw new EpubInspectError('ZIP 条目数量超过安全预算,拒绝导入', 'budget', 'budget');
  }
  const totalUncompressedBytes = entries.reduce(
    (total, entry) => total + entry.uncompressedSize,
    0,
  );
  if (totalUncompressedBytes > EPUB_RESOURCE_BUDGET.maxTotalUncompressedBytes) {
    throw new EpubInspectError('EPUB 解压后的总资源超过安全预算,拒绝导入', 'budget', 'budget');
  }

  for (const entry of entries) {
    if (entry.flags & 0x0001) {
      throw new EpubInspectError('不支持商业 DRM 或无法解密的 EPUB', 'drm', 'drm');
    }
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const containerEntry = byName.get('META-INF/container.xml');
  if (!containerEntry) {
    throw new EpubInspectError('缺少 META-INF/container.xml,不是有效的 EPUB', 'unsupported', 'container');
  }
  const containerXml = await readRequiredXml(bytes, containerEntry, 'container.xml');
  const container = parseXml(containerXml, 'container.xml');
  const rootfile = elementsByLocalName(container, 'rootfile').find(
    (candidate) => candidate.getAttribute('full-path'),
  );
  const rawOpfPath = rootfile?.getAttribute('full-path');
  if (!rawOpfPath) {
    throw new EpubInspectError('container.xml 未声明 OPF 清单路径', 'corrupt', 'container');
  }
  const opfPath = normalizeArchivePath(rawOpfPath, 'OPF 路径');
  const opfEntry = byName.get(opfPath);
  if (!opfEntry) {
    throw new EpubInspectError(`缺少 OPF 清单文件:${opfPath}`, 'corrupt', 'opf');
  }
  const opfXml = await readRequiredXml(bytes, opfEntry, 'OPF 清单');
  const opf = parseXml(opfXml, 'OPF 清单');

  const title = firstText(opf, 'title');
  if (!title) {
    throw new EpubInspectError('EPUB 缺少书名(title)', 'corrupt', 'opf');
  }
  const metadata: SourceMetadata = {
    title,
    author: firstText(opf, 'creator'),
    language: firstText(opf, 'language'),
  };

  const manifest = parseManifest(opf, opfPath);
  const spineElement = elementsByLocalName(opf, 'spine')[0];
  if (!spineElement) {
    throw new EpubInspectError('OPF 缺少 spine,无法确定正文顺序', 'corrupt', 'spine');
  }
  const spine = parseSpine(spineElement, manifest);
  if (spine.length === 0) {
    throw new EpubInspectError('EPUB spine 没有可阅读章节', 'corrupt', 'spine');
  }

  await inspectEncryption(bytes, byName, manifest);
  const report: EpubPreflightReport = {
    unavailableChapters: [],
    degradedResources: [],
    navigation: await inspectNavigation(bytes, byName, manifest, spineElement),
  };

  const firstReadableIndex = findFirstReadableSpineIndex(spine);
  if (firstReadableIndex < 0) {
    throw new EpubInspectError('EPUB 没有首个可阅读章节', 'corrupt', 'first-chapter');
  }
  for (const [spineIndex, item] of spine.entries()) {
    const isFirstReadable = spineIndex === firstReadableIndex;
    const result = await inspectChapter(bytes, byName, item, spineIndex, isFirstReadable);
    if (result) {
      report.unavailableChapters.push(result);
    }
  }

  const spinePaths = new Set(spine.map((item) => item.path).filter(isNonNull));
  const navigationPaths = new Set(
    [report.navigation.source === 'nav' ? findNavItem(manifest)?.path : null,
      report.navigation.source === 'ncx' ? findNcxItem(manifest, spineElement)?.path : null]
      .filter(isNonNull),
  );
  const coverId = elementsByLocalName(opf, 'meta').find(
    (element) => element.getAttribute('name') === 'cover',
  )?.getAttribute('content');
  const coverPath = manifest.find(
    (item) =>
      (coverId !== null && coverId !== undefined && item.id === coverId) ||
      item.properties.includes('cover-image'),
  )?.path;
  const corePaths = new Set([...spinePaths, ...navigationPaths, opfPath, 'META-INF/container.xml']);
  const manifestPaths = new Set(manifest.map((item) => item.path).filter(isNonNull));
  for (const item of manifest) {
    if (!item.path || corePaths.has(item.path)) {
      continue;
    }
    const entry = byName.get(item.path);
    if (!entry) {
      report.degradedResources.push({
        path: item.path,
        category: resourceCategory(item, coverPath),
        reason: 'corrupt',
      });
      continue;
    }
    const reason = entryBudgetReason(entry, EPUB_RESOURCE_BUDGET.maxEntryUncompressedBytes);
    if (reason) {
      report.degradedResources.push({
        path: item.path,
        category: resourceCategory(item, coverPath),
        reason,
      });
    }
  }
  for (const entry of entries) {
    if (corePaths.has(entry.name) || manifestPaths.has(entry.name)) {
      continue;
    }
    if (entryBudgetReason(entry, EPUB_RESOURCE_BUDGET.maxEntryUncompressedBytes)) {
      throw new EpubInspectError(
        `未声明的 ZIP 条目超过安全预算:${entry.name}`,
        'budget',
        'budget',
      );
    }
  }

  return {
    metadata,
    hasCover: coverPath !== null && coverPath !== undefined,
    preflight: report,
  };
}

async function inspectChapter(
  bytes: Uint8Array,
  byName: Map<string, ZipEntry>,
  item: SpineItem,
  spineIndex: number,
  isFirstReadable: boolean,
): Promise<EpubUnavailableChapter | null> {
  const path = item.path ?? '';
  const unavailable = (reason: EpubDegradationReason): EpubUnavailableChapter => ({
    spineIndex,
    path,
    reason,
  });
  if (!item.manifest || !isReadableChapter(item.manifest.mediaType) || !item.path) {
    if (isFirstReadable) {
      throw new EpubInspectError('首个可读章节结构无效,拒绝导入', 'corrupt', 'first-chapter');
    }
    return unavailable('unsupported');
  }
  const entry = byName.get(item.path);
  if (!entry) {
    if (isFirstReadable) {
      throw new EpubInspectError(`首个可读章节缺失:${item.path}`, 'corrupt', 'first-chapter');
    }
    return unavailable('corrupt');
  }
  const budgetReason = entryBudgetReason(
    entry,
    Math.min(
      EPUB_RESOURCE_BUDGET.maxEntryUncompressedBytes,
      EPUB_RESOURCE_BUDGET.maxChapterUncompressedBytes,
    ),
  );
  if (budgetReason) {
    if (isFirstReadable) {
      throw new EpubInspectError('首个可读章节超过安全资源预算,拒绝导入', 'budget', 'first-chapter');
    }
    return unavailable('budget');
  }
  try {
    const chapter = await readZipEntry(bytes, path, {
      maxUncompressedBytes: EPUB_RESOURCE_BUDGET.maxChapterUncompressedBytes,
    });
    if (!chapter) {
      throw new ZipError(`章节不存在:${path}`, 'corrupt');
    }
    parseXml(chapter, `章节:${path}`);
  } catch (error) {
    if (isFirstReadable) {
      if (error instanceof EpubInspectError && error.kind === 'budget') {
        throw new EpubInspectError('首个可读章节嵌套深度超过安全预算,拒绝导入', 'budget', 'first-chapter');
      }
      if (error instanceof ZipBudgetError) {
        throw new EpubInspectError('首个可读章节超过安全资源预算,拒绝导入', 'budget', 'first-chapter');
      }
      throw new EpubInspectError('首个可读章节损坏,拒绝导入', 'corrupt', 'first-chapter');
    }
    return unavailable(
      (error instanceof ZipBudgetError ||
        (error instanceof EpubInspectError && error.kind === 'budget'))
        ? 'budget'
        : 'corrupt',
    );
  }
  return null;
}

async function inspectNavigation(
  bytes: Uint8Array,
  byName: Map<string, ZipEntry>,
  manifest: ManifestItem[],
  spine: Element,
): Promise<EpubNavigationPreflight> {
  const candidates: Array<{ source: 'nav' | 'ncx'; item: ManifestItem | null }> = [
    { source: 'nav', item: findNavItem(manifest) },
    { source: 'ncx', item: findNcxItem(manifest, spine) },
  ];
  const present = candidates.filter((candidate) => candidate.item !== null);
  if (present.length === 0) {
    return { state: 'missing', source: 'none' };
  }
  let failureReason: EpubDegradationReason = 'corrupt';
  for (const candidate of present) {
    const item = candidate.item;
    if (!item?.path) {
      failureReason = 'corrupt';
      continue;
    }
    const entry = byName.get(item.path);
    if (!entry) {
      failureReason = 'corrupt';
      continue;
    }
    const reason = entryBudgetReason(entry, EPUB_RESOURCE_BUDGET.maxEntryUncompressedBytes);
    if (reason) {
      failureReason = reason;
      continue;
    }
    try {
      const data = await readZipEntry(bytes, item.path, {
        maxUncompressedBytes: EPUB_RESOURCE_BUDGET.maxEntryUncompressedBytes,
      });
      if (!data) {
        failureReason = 'corrupt';
        continue;
      }
      parseXml(data, `目录:${item.path}`);
      return { state: 'available', source: candidate.source };
    } catch (error) {
      failureReason =
        error instanceof ZipBudgetError ||
        (error instanceof EpubInspectError && error.kind === 'budget')
          ? 'budget'
          : 'corrupt';
    }
  }
  return { state: 'degraded', source: present[0]?.source ?? 'none', reason: failureReason };
}

async function inspectEncryption(
  bytes: Uint8Array,
  byName: Map<string, ZipEntry>,
  manifest: ManifestItem[],
): Promise<void> {
  const rightsEntry = byName.get('META-INF/rights.xml');
  const encryptionEntry = byName.get('META-INF/encryption.xml');
  if (rightsEntry) {
    throw new EpubInspectError('不支持商业 DRM 或无法解密的 EPUB', 'drm', 'drm');
  }
  if (!encryptionEntry) {
    return;
  }
  const encryptionXml = await readRequiredXml(bytes, encryptionEntry, 'encryption.xml');
  const encryption = parseXml(encryptionXml, 'encryption.xml');
  const encryptedData = elementsByLocalName(encryption, 'EncryptedData');
  if (encryptedData.length === 0) {
    throw new EpubInspectError('EPUB 加密信息无法识别,不支持商业 DRM', 'drm', 'drm');
  }
  for (const encrypted of encryptedData) {
    const algorithm = elementsByLocalName(encrypted, 'EncryptionMethod')[0]?.getAttribute('Algorithm');
    const rawUri = elementsByLocalName(encrypted, 'CipherReference')[0]?.getAttribute('URI');
    const uri = rawUri ? normalizeArchivePath(rawUri, '加密资源路径') : null;
    const font = uri ? manifest.find((item) => item.path === uri && isFontItem(item)) : undefined;
    if (!algorithm || !uri || !FONT_OBFUSCATION_ALGORITHMS.has(algorithm) || !font) {
      throw new EpubInspectError('不支持商业 DRM 或无法解密的 EPUB', 'drm', 'drm');
    }
  }
}

async function readRequiredXml(
  bytes: Uint8Array,
  entry: ZipEntry,
  label: string,
): Promise<Uint8Array> {
  const reason = entryBudgetReason(entry, EPUB_RESOURCE_BUDGET.maxEntryUncompressedBytes);
  if (reason) {
    throw new EpubInspectError(`${label}超过安全资源预算`, 'budget', 'budget');
  }
  const data = await readZipEntry(bytes, entry.name, {
    maxUncompressedBytes: EPUB_RESOURCE_BUDGET.maxEntryUncompressedBytes,
  });
  if (!data) {
    throw new EpubInspectError(`缺少${label}`, 'corrupt');
  }
  return data;
}

function parseManifest(opf: Document, opfPath: string): ManifestItem[] {
  const items: ManifestItem[] = [];
  for (const element of elementsByLocalName(opf, 'item')) {
    const id = element.getAttribute('id');
    const href = element.getAttribute('href');
    const mediaType = element.getAttribute('media-type');
    if (!id || !href || !mediaType) {
      throw new EpubInspectError('OPF manifest 存在缺少 id、href 或 media-type 的条目', 'corrupt', 'opf');
    }
    items.push({
      id,
      href,
      mediaType,
      properties: (element.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
      path: resolvePackageHref(opfPath, href),
    });
  }
  return items;
}

function parseSpine(spine: Element, manifest: ManifestItem[]): SpineItem[] {
  const byId = new Map(manifest.map((item) => [item.id, item]));
  return elementsByLocalName(spine, 'itemref').map((itemref) => {
    const idref = itemref.getAttribute('idref');
    const item = idref ? byId.get(idref) ?? null : null;
    return {
      manifest: item,
      path: item?.path ?? null,
      linear: itemref.getAttribute('linear') ?? 'yes',
    };
  });
}

function findFirstReadableSpineIndex(spine: SpineItem[]): number {
  return spine.findIndex((item) => item.linear !== 'no');
}

function findNavItem(manifest: ManifestItem[]): ManifestItem | null {
  return manifest.find((item) => item.properties.includes('nav')) ?? null;
}

function findNcxItem(manifest: ManifestItem[], spine: Element): ManifestItem | null {
  const tocId = spine.getAttribute('toc');
  return (
    (tocId ? manifest.find((item) => item.id === tocId) : undefined) ??
    manifest.find((item) => item.mediaType === 'application/x-dtbncx+xml') ??
    null
  );
}

function isReadableChapter(mediaType: string): boolean {
  return (
    mediaType === 'application/xhtml+xml' ||
    mediaType === 'text/html' ||
    mediaType === 'application/x-dtbook+xml'
  );
}

function isFontItem(item: ManifestItem): boolean {
  return (
    item.mediaType.startsWith('font/') ||
    item.mediaType.includes('font') ||
    /\.(?:woff2?|ttf|otf|sfnt)$/i.test(item.path ?? '')
  );
}

function resourceCategory(
  item: ManifestItem,
  coverPath: string | null | undefined,
): EpubResourceCategory {
  if (item.path === coverPath || item.properties.includes('cover-image')) {
    return 'cover';
  }
  if (/footnotes?/i.test(`${item.id}/${item.href}`) || item.properties.includes('footnote')) {
    return 'footnote';
  }
  if (item.mediaType === 'image/svg+xml') {
    return 'svg';
  }
  if (item.mediaType.startsWith('image/')) {
    return 'image';
  }
  if (isFontItem(item)) {
    return 'font';
  }
  if (item.mediaType.startsWith('audio/') || item.mediaType.startsWith('video/')) {
    return 'media';
  }
  return 'resource';
}

function entryBudgetReason(
  entry: ZipEntry,
  maxUncompressedBytes: number,
): EpubDegradationReason | null {
  if (entry.uncompressedSize > maxUncompressedBytes) {
    return 'budget';
  }
  if (compressionRatio(entry) > EPUB_RESOURCE_BUDGET.maxCompressionRatio) {
    return 'budget';
  }
  return null;
}

function compressionRatio(entry: ZipEntry): number {
  if (entry.uncompressedSize === 0) {
    return 1;
  }
  if (entry.compressedSize === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return entry.uncompressedSize / entry.compressedSize;
}

function parseXml(bytes: Uint8Array, label: string): Document {
  let xml: string;
  try {
    xml = UTF8_DECODER.decode(bytes);
  } catch {
    throw new EpubInspectError(`${label}不是有效的 UTF-8 XML`, 'corrupt');
  }
  assertXmlNestingDepth(xml, label);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const parserError = elementsByLocalName(doc, 'parsererror')[0];
  if (parserError) {
    throw new EpubInspectError(`${label}不是有效的 XML`, 'corrupt');
  }
  return doc;
}

/** 线性扫描 XML/HTML 标签，先于 DOMParser 拒绝过深文档。 */
function assertXmlNestingDepth(xml: string, label: string): void {
  let depth = 0;
  let maximum = 0;
  for (let index = 0; index < xml.length; index += 1) {
    if (xml[index] !== '<') {
      continue;
    }
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end < 0) {
        throw new EpubInspectError(`${label}包含未闭合注释`, 'corrupt');
      }
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end < 0) {
        throw new EpubInspectError(`${label}包含未闭合 CDATA`, 'corrupt');
      }
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<!', index) && !xml.startsWith('<![CDATA[', index)) {
      const end = scanTagEnd(xml, index + 2, label);
      const declaration = xml.slice(index + 2, end).trim().toUpperCase();
      if (declaration.startsWith('DOCTYPE')) {
        throw new EpubInspectError(`${label}不允许包含 DOCTYPE`, 'corrupt');
      }
      index = end;
      continue;
    }
    if (xml.startsWith('<?', index)) {
      index = scanTagEnd(xml, index + 2, label);
      continue;
    }
    const closing = xml[index + 1] === '/';
    const tagStart = index + (closing ? 2 : 1);
    const first = xml[tagStart] ?? '';
    if (!/[A-Za-z_:]/.test(first)) {
      continue;
    }
    const end = scanTagEnd(xml, tagStart, label);
    const selfClosing = /\/\s*$/.test(xml.slice(tagStart, end));
    if (closing) {
      depth -= 1;
      if (depth < 0) {
        throw new EpubInspectError(`${label}标签嵌套结构损坏`, 'corrupt');
      }
    } else if (!selfClosing) {
      depth += 1;
      maximum = Math.max(maximum, depth);
      if (maximum > EPUB_RESOURCE_BUDGET.maxXmlNestingDepth) {
        throw new EpubInspectError(`${label}嵌套深度超过安全预算`, 'budget', 'budget');
      }
    }
    index = end;
  }
}

function scanTagEnd(xml: string, start: number, label: string): number {
  let quote = '';
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  throw new EpubInspectError(`${label}包含未闭合标签`, 'corrupt');
}

function elementsByLocalName(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', localName));
}

function firstText(doc: Document, localName: string): string | null {
  const element = elementsByLocalName(doc, localName)[0];
  const text = element?.textContent?.trim();
  return text ? text : null;
}

function normalizeArchivePath(path: string, label: string): string {
  const normalized = resolvePackageHref('', path);
  if (!normalized) {
    throw new EpubInspectError(`${label}不是包内相对路径`, 'corrupt', 'opf');
  }
  return normalized;
}

function resolvePackageHref(opfPath: string, href: string): string | null {
  const withoutFragment = href.split('#', 1)[0]?.split('?', 1)[0] ?? '';
  if (
    !withoutFragment ||
    /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/)/.test(withoutFragment)
  ) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    throw new EpubInspectError(`包内资源路径无法解码:${href}`, 'corrupt', 'opf');
  }
  const base = opfPath ? opfPath.split('/').slice(0, -1) : [];
  const parts = [...base, ...decoded.replace(/\\/g, '/').split('/')];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      if (normalized.length === 0) {
        throw new EpubInspectError(`包内资源路径越界:${href}`, 'corrupt', 'opf');
      }
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join('/') || null;
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function hasZipHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}
