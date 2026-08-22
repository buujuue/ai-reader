import {
  openZipArchive,
  type ZipEntry,
  type ZipSource,
} from '../library/epub/zip';
import type { NativeEpubPrefetch } from './nativeEpub';

/** foliate-js EPUB 构造器需要的最小 ZIP 条目形状。 */
export interface FoliateZipEntry {
  filename: string;
  uncompressedSize: number;
}

export interface FoliateEpubLoader {
  entries: FoliateZipEntry[];
  loadText: (name: string) => Promise<string | null>;
  loadBlob: (name: string, type?: string) => Promise<Blob | null>;
  getSize: (name: string) => number;
  sha1: undefined;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function resolveEntry(
  entries: readonly ZipEntry[],
  requestedName: string,
): ZipEntry | undefined {
  const direct = entries.find((entry) => entry.name === requestedName);
  if (direct) return direct;
  const encoded = requestedName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  if (encoded !== requestedName) {
    const encodedEntry = entries.find((entry) => entry.name === encoded);
    if (encodedEntry) return encodedEntry;
  }
  try {
    const decoded = decodeURIComponent(requestedName);
    return decoded === requestedName
      ? undefined
      : entries.find((entry) => entry.name === decoded);
  } catch {
    return undefined;
  }
}

/**
 * 用项目自己的受预算 ZIP 读取器构造 foliate-js loader。
 *
 * `prefetch` 只覆盖 container/OPF/NAV/NCX 和尺寸表；章节、图片、字体等
 * 仍由同一份 JavaScript ZIP loader 按需读取，确保原生路径不拥有第二套
 * EPUB 语义，也不会产生“半原生”章节对象。
 */
export async function createFoliateEpubLoader(
  file: ZipSource,
  prefetch?: NativeEpubPrefetch | null,
): Promise<FoliateEpubLoader> {
  const archive = await openZipArchive(file);
  const zipEntries = archive.entries;
  const entries = zipEntries.map((entry) => ({
    filename: entry.name,
    uncompressedSize: entry.uncompressedSize,
  }));
  const textDecoder = new TextDecoder('utf-8');
  const textCache = prefetch?.textCache;
  const sizeCache = prefetch?.sizes;

  const pendingReads = new Map<string, Promise<Uint8Array | null>>();
  const read = (name: string): Promise<Uint8Array | null> => {
    const entry = resolveEntry(zipEntries, name);
    if (!entry) return Promise.resolve(null);
    const pending = pendingReads.get(entry.name);
    if (pending) return pending;
    const request = archive.readEntry(entry.name);
    pendingReads.set(entry.name, request);
    void request.then(
      () => pendingReads.delete(entry.name),
      () => pendingReads.delete(entry.name),
    );
    return request;
  };

  return {
    entries,
    async loadText(name: string): Promise<string | null> {
      const cached = textCache?.get(name);
      if (cached !== undefined) return cached;
      const data = await read(name);
      return data === null ? null : textDecoder.decode(data);
    },
    async loadBlob(name: string, type?: string): Promise<Blob | null> {
      const data = await read(name);
      if (data === null) return null;
      return type
        ? new Blob([asArrayBuffer(data)], { type })
        : new Blob([asArrayBuffer(data)]);
    },
    getSize(name: string): number {
      const entry = resolveEntry(zipEntries, name);
      const cached = sizeCache?.get(name) ??
        (entry ? sizeCache?.get(entry.name) : undefined);
      if (cached !== undefined) return cached;
      return entry?.uncompressedSize ?? 0;
    },
    sha1: undefined,
  };
}

/** 用同一个 foliate-js EPUB 实现打开有/无原生预取的 Book。 */
export async function openFoliateEpub(
  file: ZipSource,
  prefetch?: NativeEpubPrefetch | null,
): Promise<unknown> {
  const module = (await import('foliate-js/epub.js')) as unknown as {
    EPUB: new (loader: FoliateEpubLoader) => { init: () => Promise<unknown> };
  };
  const loader = await createFoliateEpubLoader(file, prefetch);
  return new module.EPUB(loader).init();
}

export interface FoliateEpubSemanticSnapshot {
  title: string | null;
  author: string | null;
  language: string | null;
  hasCover: boolean;
  /** 由同一份 foliate-js 语义选择出的来源封面;预检可关闭二进制读取。 */
  cover: Blob | null;
}

export interface ReadFoliateEpubSemanticsOptions {
  /** 预检只需要结构性封面标记时关闭二进制封面读取。 */
  loadCover?: boolean;
}

interface FoliateBookSemanticShape {
  metadata?: {
    title?: unknown;
    author?: unknown;
    language?: unknown;
  };
  getCover?: () => Promise<Blob | null>;
}

function flattenMetadata(value: unknown): string | null {
  if (typeof value === 'string') {
    const result = value.trim();
    return result || null;
  }
  if (Array.isArray(value)) {
    const result = value
      .map((item) => flattenMetadata(item))
      .filter((item): item is string => item !== null)
      .join(', ')
      .trim();
    return result || null;
  }
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    for (const key of ['name', 'value', 'label', 'und']) {
      const result = flattenMetadata(candidate[key]);
      if (result) return result;
    }
    for (const nested of Object.values(candidate)) {
      const result = flattenMetadata(nested);
      if (result) return result;
    }
  }
  return null;
}

/** 统一暴露 Foliate 的 EPUB 可观察语义，避免其它格式模块直接触碰 Book 对象。 */
export async function readFoliateEpubSemantics(
  file: ZipSource,
  prefetch?: NativeEpubPrefetch | null,
  options: ReadFoliateEpubSemanticsOptions = {},
): Promise<FoliateEpubSemanticSnapshot> {
  const book = (await openFoliateEpub(file, prefetch)) as FoliateBookSemanticShape;
  const cover: Blob | null = options.loadCover === false
    ? null
    : (await book.getCover?.().catch(() => null)) ?? null;
  return {
    title: flattenMetadata(book.metadata?.title),
    author: flattenMetadata(book.metadata?.author),
    language: flattenMetadata(book.metadata?.language),
    hasCover: cover !== null && cover !== undefined,
    cover,
  };
}
