/**
 * 与 File/Blob 兼容的托管材料只读来源。
 *
 * 该类型只知道材料的描述信息和一个按范围读取的窄回调，不知道 Tauri
 * 命令、数据库或文件系统路径。缓存按 128 KiB 分块，并只保留最近使用的
 * 128 个分块；同一分块的并发读取共享同一个 Promise。
 */

export const MANAGED_FILE_SOURCE_CHUNK_SIZE = 128 * 1024;
export const MANAGED_FILE_SOURCE_MAX_CACHED_CHUNKS = 128;

export interface ManagedFileSourceDescriptor {
  name: string;
  size: number;
  type?: string;
  lastModified?: number;
}

export type ManagedFileRangeReader = (
  offset: number,
  length: number,
) => Promise<Uint8Array>;

/** 延迟加载的 Blob，slice() 不会提前触发托管文件读取。 */
class DeferredBlob extends Blob {
  readonly #read: () => Promise<ArrayBuffer>;
  readonly #size: number;
  readonly #type: string;

  constructor(size: number, type: string, read: () => Promise<ArrayBuffer>) {
    super();
    this.#size = size;
    this.#type = type;
    this.#read = read;
  }

  override get size(): number {
    return this.#size;
  }

  override get type(): string {
    return this.#type;
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#read();
  }

  override async text(): Promise<string> {
    return new TextDecoder().decode(await this.#read());
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let consumed = false;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: async (controller) => {
        if (consumed) {
          controller.close();
          return;
        }
        consumed = true;
        controller.enqueue(new Uint8Array<ArrayBuffer>(await this.#read()));
        controller.close();
      },
    });
  }

  override slice(
    start = 0,
    end = this.size,
    contentType = this.type,
  ): Blob {
    const [normalizedStart, normalizedEnd] = normalizeBlobRange(start, end, this.size);
    const size = normalizedEnd - normalizedStart;
    return new DeferredBlob(size, contentType, async () => {
      const bytes = new Uint8Array(await this.#read());
      return toArrayBuffer(bytes.slice(normalizedStart, normalizedEnd));
    });
  }
}

/**
 * 托管材料的只读 File 实现。
 *
 * File 的同步元数据与 Blob 的延迟内容读取保持兼容，因此格式层可以把它
 * 当成普通 File/Blob 使用，而无需知道材料来自哪里。
 */
export class ManagedFileSource extends File {
  readonly #size: number;
  readonly #name: string;
  readonly #type: string;
  readonly #lastModified: number;
  readonly #readRange: ManagedFileRangeReader;
  readonly #cache = new Map<number, Uint8Array>();
  readonly #accessOrder: number[] = [];
  readonly #pendingChunks = new Map<number, Promise<Uint8Array>>();

  constructor(
    descriptor: ManagedFileSourceDescriptor,
    readRange: ManagedFileRangeReader,
  ) {
    const size = assertSafeSize(descriptor.size);
    const name = descriptor.name;
    const type = descriptor.type ?? managedFileTypeFromName(name);
    const lastModified = descriptor.lastModified ?? 0;
    super([], name, { type, lastModified });
    this.#size = size;
    this.#name = name;
    this.#type = type;
    this.#lastModified = lastModified;
    this.#readRange = readRange;
  }

  override get name(): string {
    return this.#name;
  }

  override get size(): number {
    return this.#size;
  }

  override get type(): string {
    return this.#type;
  }

  override get lastModified(): number {
    return this.#lastModified;
  }

  /**
   * 按半开区间读取内容。该方法是 Blob.slice()/arrayBuffer() 的内部能力，
   * 也便于格式适配器在需要时直接读取一小段内容。
   */
  async readRange(offset: number, length: number): Promise<ArrayBuffer> {
    assertRange(offset, length, this.#size);
    return this.#readBytes(offset, offset + length);
  }

  /** 供 Reader Runtime 预算诊断使用；不暴露正文或文件路径。 */
  getRuntimeResourceUsage(): { rangeCacheBytes: number } {
    return {
      rangeCacheBytes: [...this.#cache.values()].reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      ),
    };
  }

  override slice(
    start = 0,
    end = this.size,
    contentType = this.type,
  ): Blob {
    const [normalizedStart, normalizedEnd] = normalizeBlobRange(start, end, this.size);
    const size = normalizedEnd - normalizedStart;
    return new DeferredBlob(size, contentType, () =>
      this.#readBytes(normalizedStart, normalizedEnd),
    );
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#readBytes(0, this.size);
  }

  override async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let offset = 0;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: async (controller) => {
        if (offset >= this.size) {
          controller.close();
          return;
        }
        const end = Math.min(offset + MANAGED_FILE_SOURCE_CHUNK_SIZE, this.size);
        const bytes = new Uint8Array<ArrayBuffer>(await this.#readBytes(offset, end));
        offset = end;
        controller.enqueue(bytes);
      },
    });
  }

  async #readBytes(start: number, end: number): Promise<ArrayBuffer> {
    const size = end - start;
    if (size === 0) return new ArrayBuffer(0);

    const firstChunk = Math.floor(start / MANAGED_FILE_SOURCE_CHUNK_SIZE);
    const lastChunk = Math.floor((end - 1) / MANAGED_FILE_SOURCE_CHUNK_SIZE);
    const chunks = await Promise.all(
      Array.from({ length: lastChunk - firstChunk + 1 }, (_, index) =>
        this.#getChunk(firstChunk + index),
      ),
    );
    const result = new Uint8Array(size);
    let resultOffset = 0;
    for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
      const chunk = chunks[chunkIndex - firstChunk];
      if (!chunk) throw new Error(`托管材料分块缺失:${chunkIndex}`);
      const chunkStart = chunkIndex * MANAGED_FILE_SOURCE_CHUNK_SIZE;
      const from = Math.max(start, chunkStart) - chunkStart;
      const to = Math.min(end, chunkStart + chunk.byteLength) - chunkStart;
      const selected = chunk.subarray(from, to);
      result.set(selected, resultOffset);
      resultOffset += selected.byteLength;
    }
    return result.buffer;
  }

  #getChunk(chunkIndex: number): Promise<Uint8Array> {
    const cached = this.#cache.get(chunkIndex);
    if (cached) {
      this.#touch(chunkIndex);
      return Promise.resolve(cached);
    }

    const pending = this.#pendingChunks.get(chunkIndex);
    if (pending) return pending;

    const offset = chunkIndex * MANAGED_FILE_SOURCE_CHUNK_SIZE;
    const length = Math.min(MANAGED_FILE_SOURCE_CHUNK_SIZE, this.size - offset);
    const request = this.#readRange(offset, length).then((bytes) => {
      if (bytes.byteLength !== length) {
        throw new Error(
          `托管材料范围读取返回长度不匹配:期望 ${length},实际 ${bytes.byteLength}`,
        );
      }
      const cachedBytes = new Uint8Array(bytes);
      this.#cache.set(chunkIndex, cachedBytes);
      this.#touch(chunkIndex);
      this.#trimCache();
      return cachedBytes;
    });
    this.#pendingChunks.set(chunkIndex, request);
    void request.then(
      () => this.#pendingChunks.delete(chunkIndex),
      () => this.#pendingChunks.delete(chunkIndex),
    );
    return request;
  }

  #touch(chunkIndex: number): void {
    const existing = this.#accessOrder.indexOf(chunkIndex);
    if (existing >= 0) this.#accessOrder.splice(existing, 1);
    this.#accessOrder.unshift(chunkIndex);
  }

  #trimCache(): void {
    while (this.#cache.size > MANAGED_FILE_SOURCE_MAX_CACHED_CHUNKS) {
      const oldest = this.#accessOrder.pop();
      if (oldest === undefined) return;
      this.#cache.delete(oldest);
    }
  }
}

export function managedFileTypeFromName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'epub':
      return 'application/epub+zip';
    case 'pdf':
      return 'application/pdf';
    case 'md':
    case 'markdown':
    case 'mkd':
    case 'mdown':
      return 'text/markdown';
    default:
      return 'application/octet-stream';
  }
}

function assertSafeSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`托管材料大小不是安全整数:${size}`);
  }
  return size;
}

function assertRange(offset: number, length: number, size: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new RangeError(`托管材料范围参数无效:offset=${offset},length=${length}`);
  }
  if (offset > size || length > size - offset) {
    throw new RangeError(
      `托管材料范围越界:offset=${offset},length=${length},size=${size}`,
    );
  }
}

function normalizeBlobRange(start: number, end: number, size: number): [number, number] {
  const normalizedStart = normalizeBlobIndex(start, size, 0);
  const normalizedEnd = normalizeBlobIndex(end, size, size);
  return [normalizedStart, Math.max(normalizedStart, normalizedEnd)];
}

function normalizeBlobIndex(value: number, size: number, fallback: number): number {
  if (Number.isNaN(value)) return 0;
  if (value === Number.POSITIVE_INFINITY) return size;
  if (value === Number.NEGATIVE_INFINITY) return 0;
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  return integer < 0 ? Math.max(size + integer, 0) : Math.min(integer, size);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
