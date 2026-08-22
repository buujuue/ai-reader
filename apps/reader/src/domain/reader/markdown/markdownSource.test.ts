import { describe, expect, it } from 'vitest';

import {
  MANAGED_FILE_SOURCE_CHUNK_SIZE,
  ManagedFileSource,
} from '../../library/managedFileSource';
import { readMarkdownSourceText } from './markdownSource';

describe('Markdown ManagedFileSource 物化', () => {
  it('超过单次范围上限时仍通过受控分块物化完整文本', async () => {
    const size = 8 * 1024 * 1024 + 37;
    const bytes = new Uint8Array(size);
    const prefix = new TextEncoder().encode('# 大文件 Markdown\n\n');
    bytes.set(prefix);
    bytes.fill('a'.charCodeAt(0), prefix.byteLength);
    const readLengths: number[] = [];
    const source = new ManagedFileSource(
      { name: 'large.md', size },
      async (offset, length) => {
        readLengths.push(length);
        return bytes.slice(offset, offset + length);
      },
    );

    const text = await readMarkdownSourceText(source);

    expect(text).toBe(new TextDecoder().decode(bytes));
    expect(Math.max(...readLengths)).toBe(MANAGED_FILE_SOURCE_CHUNK_SIZE);
    expect(readLengths).toHaveLength(Math.ceil(size / MANAGED_FILE_SOURCE_CHUNK_SIZE));
  });

  it('跨分块的 UTF-8 字符不会被拆坏', async () => {
    const prefix = new Uint8Array(MANAGED_FILE_SOURCE_CHUNK_SIZE - 1).fill(97);
    const suffix = new TextEncoder().encode('中');
    const bytes = new Uint8Array(prefix.byteLength + suffix.byteLength);
    bytes.set(prefix);
    bytes.set(suffix, prefix.byteLength);
    const source = new ManagedFileSource(
      { name: 'unicode.md', size: bytes.byteLength },
      async (offset, length) => bytes.slice(offset, offset + length),
    );

    await expect(readMarkdownSourceText(source)).resolves.toBe(
      `${'a'.repeat(prefix.byteLength)}中`,
    );
  });
});
