/**
 * 最小的 ZIP 解析器,仅用于读取 EPUB 的清单与元数据条目。
 * 支持 stored(0) 与 deflate(8) 两种压缩方式;deflate 复用平台原生 DecompressionStream。
 * 不用于大文件整包解压,只按需读取单个条目。
 */

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

const decoder = new TextDecoder('utf-8');

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minStart = Math.max(0, bytes.byteLength - 22 - 65535);
  for (let offset = bytes.byteLength - 22; offset >= minStart; offset -= 1) {
    if (readU32(view, offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/** 解析中央目录,返回按名称索引的条目信息。 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw new Error('无效的 ZIP 文件:找不到中央目录结束标记');
  }

  const totalEntries = readU16(view, eocdOffset + 10);
  const centralDirectoryOffset = readU32(view, eocdOffset + 16);

  const entries: ZipEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readU32(view, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('无效的 ZIP 文件:中央目录条目签名错误');
    }
    const compressionMethod = readU16(view, cursor + 10);
    const compressedSize = readU32(view, cursor + 20);
    const uncompressedSize = readU32(view, cursor + 24);
    const nameLength = readU16(view, cursor + 28);
    const extraLength = readU16(view, cursor + 30);
    const commentLength = readU16(view, cursor + 32);
    const localHeaderOffset = readU32(view, cursor + 42);
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 读取单个条目的解压字节。找不到返回 null。 */
export async function readZipEntry(
  bytes: Uint8Array,
  name: string,
): Promise<Uint8Array | null> {
  const entry = listZipEntries(bytes).find((candidate) => candidate.name === name);
  if (!entry) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataOffset = readLocalDataOffset(bytes, entry.localHeaderOffset);
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    return await inflate(compressed);
  }
  throw new Error(`不支持的 ZIP 压缩方式:${entry.compressionMethod}`);
}

function readLocalDataOffset(bytes: Uint8Array, localHeaderOffset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readU32(view, localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error('无效的 ZIP 文件:本地文件头签名错误');
  }
  const nameLength = readU16(view, localHeaderOffset + 26);
  const extraLength = readU16(view, localHeaderOffset + 28);
  return localHeaderOffset + 30 + nameLength + extraLength;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
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
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
