import { EPUB_RESOURCE_BUDGET } from './epubBudget';

/** ZIP 中央目录暴露给 EPUB 预检与读取器的最小条目描述。 */
export interface ZipEntry {
  name: string;
  /** ZIP general-purpose bit flag；最低位表示 ZIP 层加密。 */
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export type ZipErrorKind = 'corrupt' | 'budget' | 'encrypted';

/** ZIP 解析、预算和加密状态的稳定领域错误。 */
export class ZipError extends Error {
  override name = 'ZipError';

  constructor(
    message: string,
    readonly kind: ZipErrorKind,
  ) {
    super(message);
  }
}

export class ZipBudgetError extends ZipError {
  override name = 'ZipBudgetError';

  constructor(message: string) {
    super(message, 'budget');
  }
}

export class ZipEncryptionError extends ZipError {
  override name = 'ZipEncryptionError';

  constructor(message: string) {
    super(message, 'encrypted');
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

const decoder = new TextDecoder('utf-8', { fatal: true });

function readU16(view: DataView, offset: number, label: string): number {
  ensureRange(view.byteLength, offset, 2, label);
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number, label: string): number {
  ensureRange(view.byteLength, offset, 4, label);
  return view.getUint32(offset, true);
}

function ensureRange(
  byteLength: number,
  offset: number,
  length: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > byteLength - length
  ) {
    throw new ZipError(`ZIP 读取越界:${label}`, 'corrupt');
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.byteLength < 22) {
    return -1;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minStart = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let offset = bytes.byteLength - 22; offset >= minStart; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) {
      return offset;
    }
  }
  return -1;
}

function decodeName(bytes: Uint8Array, offset: number, length: number): string {
  try {
    return decoder.decode(bytes.subarray(offset, offset + length));
  } catch {
    throw new ZipError('ZIP 条目名称不是有效的 UTF-8', 'corrupt');
  }
}

function validateEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.includes('\u0000') ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.split(/[\\/]/).some((part) => part === '..')
  ) {
    throw new ZipError(`ZIP 条目路径不安全:${name}`, 'corrupt');
  }
}

/** 解析中央目录。所有偏移、长度与计数在返回前都经过边界校验。 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw new ZipError('无效的 ZIP 文件:找不到中央目录结束标记', 'corrupt');
  }

  const diskNumber = readU16(view, eocdOffset + 4, 'EOCD 磁盘编号');
  const centralDisk = readU16(view, eocdOffset + 6, 'EOCD 中央目录磁盘编号');
  const entriesOnDisk = readU16(view, eocdOffset + 8, 'EOCD 当前磁盘条目数');
  const totalEntries = readU16(view, eocdOffset + 10, 'EOCD 条目数');
  const centralDirectorySize = readU32(view, eocdOffset + 12, 'EOCD 中央目录大小');
  const centralDirectoryOffset = readU32(view, eocdOffset + 16, 'EOCD 中央目录偏移');

  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    centralDirectorySize === ZIP64_SENTINEL ||
    centralDirectoryOffset === ZIP64_SENTINEL
  ) {
    throw new ZipError('不支持多磁盘或 ZIP64 EPUB', 'corrupt');
  }
  ensureRange(bytes.byteLength, centralDirectoryOffset, centralDirectorySize, '中央目录');
  if (centralDirectoryOffset + centralDirectorySize > eocdOffset) {
    throw new ZipError('ZIP 中央目录覆盖了 EOCD 或超出文件范围', 'corrupt');
  }

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralDirectoryOffset;
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  for (let index = 0; index < totalEntries; index += 1) {
    ensureRange(bytes.byteLength, cursor, 46, '中央目录条目');
    if (readU32(view, cursor, '中央目录签名') !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipError('无效的 ZIP 文件:中央目录条目签名错误', 'corrupt');
    }

    const flags = readU16(view, cursor + 8, 'ZIP 条目标志');
    const compressionMethod = readU16(view, cursor + 10, 'ZIP 压缩方式');
    const compressedSize = readU32(view, cursor + 20, 'ZIP 压缩大小');
    const uncompressedSize = readU32(view, cursor + 24, 'ZIP 解压大小');
    const nameLength = readU16(view, cursor + 28, 'ZIP 名称长度');
    const extraLength = readU16(view, cursor + 30, 'ZIP 扩展长度');
    const commentLength = readU16(view, cursor + 32, 'ZIP 注释长度');
    const localHeaderOffset = readU32(view, cursor + 42, 'ZIP 本地头偏移');
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      throw new ZipError('不支持 ZIP64 条目', 'corrupt');
    }

    const recordLength = 46 + nameLength + extraLength + commentLength;
    ensureRange(bytes.byteLength, cursor, recordLength, '完整中央目录条目');
    if (cursor + recordLength > centralDirectoryEnd) {
      throw new ZipError('中央目录条目超出中央目录范围', 'corrupt');
    }
    const name = decodeName(bytes, cursor + 46, nameLength);
    validateEntryName(name);
    if (names.has(name)) {
      throw new ZipError(`ZIP 存在重复条目:${name}`, 'corrupt');
    }
    names.add(name);
    entries.push({
      name,
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor += recordLength;
  }
  if (cursor !== centralDirectoryEnd) {
    throw new ZipError('中央目录大小与条目数量不一致', 'corrupt');
  }
  return entries;
}

export interface ReadZipEntryOptions {
  /** 读取时允许产生的最大解压字节数；默认使用 EPUB 单条目硬上限。 */
  maxUncompressedBytes?: number;
}

/** 读取单个条目的解压字节。找不到返回 null，不会无界解压。 */
export async function readZipEntry(
  bytes: Uint8Array,
  name: string,
  options: ReadZipEntryOptions = {},
): Promise<Uint8Array | null> {
  const entry = listZipEntries(bytes).find((candidate) => candidate.name === name);
  if (!entry) {
    return null;
  }

  const maxUncompressedBytes =
    options.maxUncompressedBytes ?? EPUB_RESOURCE_BUDGET.maxEntryUncompressedBytes;
  if (!Number.isSafeInteger(maxUncompressedBytes) || maxUncompressedBytes < 0) {
    throw new ZipBudgetError('ZIP 解压预算无效');
  }
  if (entry.uncompressedSize > maxUncompressedBytes) {
    throw new ZipBudgetError(`ZIP 条目超过解压预算:${entry.name}`);
  }
  if (entry.flags & 0x0001) {
    throw new ZipEncryptionError(`ZIP 条目已加密:${entry.name}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataOffset = readLocalDataOffset(bytes, entry, view);
  ensureRange(bytes.byteLength, dataOffset, entry.compressedSize, `条目数据:${entry.name}`);
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    if (compressed.byteLength !== entry.uncompressedSize) {
      throw new ZipError(`ZIP 条目大小声明不一致:${entry.name}`, 'corrupt');
    }
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    const inflated = await inflate(compressed, maxUncompressedBytes, entry.name);
    if (inflated.byteLength !== entry.uncompressedSize) {
      throw new ZipError(`ZIP 条目解压大小声明不一致:${entry.name}`, 'corrupt');
    }
    return inflated;
  }
  throw new ZipError(`不支持的 ZIP 压缩方式:${entry.compressionMethod}`, 'corrupt');
}

function readLocalDataOffset(
  bytes: Uint8Array,
  entry: ZipEntry,
  view: DataView,
): number {
  const offset = entry.localHeaderOffset;
  ensureRange(bytes.byteLength, offset, 30, `本地文件头:${entry.name}`);
  if (readU32(view, offset, '本地文件头签名') !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipError('无效的 ZIP 文件:本地文件头签名错误', 'corrupt');
  }
  const localFlags = readU16(view, offset + 6, '本地文件头标志');
  const localMethod = readU16(view, offset + 8, '本地文件头压缩方式');
  const nameLength = readU16(view, offset + 26, '本地文件头名称长度');
  const extraLength = readU16(view, offset + 28, '本地文件头扩展长度');
  if (
    localMethod !== entry.compressionMethod ||
    (localFlags & 0x0001) !== (entry.flags & 0x0001)
  ) {
    throw new ZipError(`ZIP 本地文件头与中央目录不一致:${entry.name}`, 'corrupt');
  }
  ensureRange(bytes.byteLength, offset + 30, nameLength, `本地文件头名称:${entry.name}`);
  if (decodeName(bytes, offset + 30, nameLength) !== entry.name) {
    throw new ZipError(`ZIP 本地文件头名称与中央目录不一致:${entry.name}`, 'corrupt');
  }
  const dataOffset = offset + 30 + nameLength + extraLength;
  ensureRange(bytes.byteLength, dataOffset, entry.compressedSize, `本地条目数据:${entry.name}`);
  return dataOffset;
}

async function inflate(
  data: Uint8Array,
  maxOutputBytes: number,
  entryName: string,
): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const output = (async (): Promise<Uint8Array> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxOutputBytes) {
        await reader.cancel();
        throw new ZipBudgetError(`ZIP 条目实际解压超过预算:${entryName}`);
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      result.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return result;
  })();

  try {
    await writer.write(data as unknown as BufferSource);
    await writer.close();
    return await output;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    let outputError: unknown;
    try {
      await output;
    } catch (secondaryError) {
      outputError = secondaryError;
      // 保留首个错误,避免解压器的二次拒绝掩盖稳定分类。
    }
    if (error instanceof ZipError) {
      throw error;
    }
    if (outputError instanceof ZipError) {
      throw outputError;
    }
    throw new ZipError(`ZIP 条目解压失败:${entryName}`, 'corrupt');
  }
}
