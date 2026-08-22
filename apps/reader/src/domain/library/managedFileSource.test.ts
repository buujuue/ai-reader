import { describe, expect, it, vi } from 'vitest';

import {
  MANAGED_FILE_SOURCE_CHUNK_SIZE,
  MANAGED_FILE_SOURCE_MAX_CACHED_CHUNKS,
  ManagedFileSource,
} from './managedFileSource';

describe('ManagedFileSource', () => {
  it('按半开区间读取，并保持 File/Blob 的同步元数据', async () => {
    const bytes = new TextEncoder().encode('0123456789');
    const readRange = vi.fn(async (offset: number, length: number) =>
      bytes.slice(offset, offset + length),
    );
    const source = new ManagedFileSource(
      { name: 'book.epub', size: bytes.byteLength },
      readRange,
    );

    expect(source).toBeInstanceOf(File);
    expect(source).toBeInstanceOf(Blob);
    expect(source.name).toBe('book.epub');
    expect(source.size).toBe(bytes.byteLength);
    expect(source.type).toBe('application/epub+zip');
    expect(new TextDecoder().decode(await source.slice(2, 6).arrayBuffer())).toBe('2345');
    expect(new TextDecoder().decode(await source.arrayBuffer())).toBe('0123456789');
    expect(readRange).toHaveBeenCalledTimes(1);
  });

  it('同一分块的并发请求共享一次底层读取', async () => {
    let release: ((value: Uint8Array) => void) | undefined;
    const bytes = new Uint8Array(MANAGED_FILE_SOURCE_CHUNK_SIZE);
    bytes.fill(65);
    const readRange = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = resolve;
        }),
    );
    const source = new ManagedFileSource(
      { name: 'book.pdf', size: bytes.byteLength },
      readRange,
    );

    const first = source.slice(10, 20).arrayBuffer();
    const second = source.slice(30, 40).arrayBuffer();
    await Promise.resolve();
    expect(readRange).toHaveBeenCalledTimes(1);

    release?.(bytes);
    expect(new Uint8Array(await first)).toEqual(new Uint8Array(10).fill(65));
    expect(new Uint8Array(await second)).toEqual(new Uint8Array(10).fill(65));
  });

  it('直接范围读取拒绝越界，并透传底层读取错误', async () => {
    const source = new ManagedFileSource(
      { name: 'book.pdf', size: 10 },
      async () => {
        throw new Error('range backend failed');
      },
    );

    await expect(source.readRange(-1, 1)).rejects.toThrow('范围参数无效');
    await expect(source.readRange(9, 2)).rejects.toThrow('范围越界');
    await expect(source.slice(0, 1).arrayBuffer()).rejects.toThrow('range backend failed');
  });

  it('直接范围读取拒绝越界，并透传底层读取错误', async () => {
    const source = new ManagedFileSource(
      { name: 'book.pdf', size: 10 },
      async () => {
        throw new Error('range backend failed');
      },
    );

    await expect(source.readRange(-1, 1)).rejects.toThrow('范围参数无效');
    await expect(source.readRange(9, 2)).rejects.toThrow('范围越界');
    await expect(source.slice(0, 1).arrayBuffer()).rejects.toThrow('range backend failed');
  });

  it('缓存最多保留 128 个分块，并淘汰最久未使用的分块', async () => {
    const calls: number[] = [];
    const readRange = vi.fn(async (offset: number, length: number) => {
      calls.push(offset);
      return new Uint8Array(length);
    });
    const source = new ManagedFileSource(
      {
        name: 'notes.md',
        size: (MANAGED_FILE_SOURCE_MAX_CACHED_CHUNKS + 1) *
          MANAGED_FILE_SOURCE_CHUNK_SIZE,
      },
      readRange,
    );

    for (let index = 0; index <= MANAGED_FILE_SOURCE_MAX_CACHED_CHUNKS; index += 1) {
      await source.slice(index * MANAGED_FILE_SOURCE_CHUNK_SIZE, index * MANAGED_FILE_SOURCE_CHUNK_SIZE + 1).arrayBuffer();
    }
    await source.slice(0, 1).arrayBuffer();

    expect(readRange).toHaveBeenCalledTimes(MANAGED_FILE_SOURCE_MAX_CACHED_CHUNKS + 2);
    expect(calls.filter((offset) => offset === 0)).toHaveLength(2);
  });

  it('slice 遵循 Blob 的负索引语义，并支持流读取', async () => {
    const bytes = new TextEncoder().encode('abcdef');
    const source = new ManagedFileSource(
      { name: 'notes.md', size: bytes.byteLength },
      async (offset, length) => bytes.slice(offset, offset + length),
    );

    expect(new TextDecoder().decode(await source.slice(-3).arrayBuffer())).toBe('def');
    const reader = source.stream().getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    expect(new TextDecoder().decode(concat(chunks))).toBe('abcdef');
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
