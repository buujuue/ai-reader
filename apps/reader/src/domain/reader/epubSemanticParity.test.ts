import { describe, expect, it } from 'vitest';

import { buildEpub } from '../library/epub/zipWriter';
import {
  NATIVE_EPUB_REQUIRED_CAPABILITIES,
  type NativeEpubPrefetch,
} from './nativeEpub';
import { createFoliateEpubLoader, openFoliateEpub } from './foliateEpubLoader';

interface FoliateBookSnapshot {
  metadata: unknown;
  toc: unknown;
  sections: Array<{ id: string; size: number; linear: string; cfi: string }>;
  coverBytes: number[] | null;
}

interface FoliateBookLike {
  metadata: unknown;
  toc?: unknown;
  sections: Array<{ id: string; size: number; linear: string; cfi: string }>;
  getCover: () => Promise<Blob | null>;
}

function asFile(bytes: Uint8Array): File {
  return new File([
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  ], 'book.epub', { type: 'application/epub+zip' });
}

async function snapshot(book: unknown): Promise<FoliateBookSnapshot> {
  const candidate = book as FoliateBookLike;
  const cover = await candidate.getCover();
  return {
    metadata: candidate.metadata,
    toc: candidate.toc,
    sections: candidate.sections.map(({ id, size, linear, cfi }) => ({ id, size, linear, cfi })),
    coverBytes: cover ? Array.from(new Uint8Array(await cover.arrayBuffer())) : null,
  };
}

describe('EPUB foliate-js 语义 parity', () => {
  it('纯 JS loader 与原生预取 loader 的元数据/目录/spine/CFI/封面一致', async () => {
    const file = asFile(
      buildEpub({
        title: '语义 parity',
        author: '作者',
        language: 'zh',
        withCover: true,
        withImage: true,
      }),
    );
    const pureLoader = await createFoliateEpubLoader(file);
    const textCache = new Map<string, string>();
    for (const name of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml']) {
      const text = await pureLoader.loadText(name);
      if (text !== null) textCache.set(name, text);
    }
    const prefetch: NativeEpubPrefetch = {
      parity: {
        protocolVersion: 1,
        semanticSource: 'foliate-js',
        platform: 'windows',
        validated: true,
        capabilities: [...NATIVE_EPUB_REQUIRED_CAPABILITIES],
      },
      textCache,
      sizes: new Map(pureLoader.entries.map((entry) => [entry.filename, entry.uncompressedSize])),
    };
    const acceleratedLoader = await createFoliateEpubLoader(file, prefetch);
    expect(acceleratedLoader.entries).toEqual(pureLoader.entries);
    expect(
      acceleratedLoader.entries.map((entry) => [
        entry.filename,
        acceleratedLoader.getSize(entry.filename),
      ]),
    ).toEqual(
      pureLoader.entries.map((entry) => [entry.filename, pureLoader.getSize(entry.filename)]),
    );

    const pure = await snapshot(await openFoliateEpub(file));
    const accelerated = await snapshot(await openFoliateEpub(file, prefetch));

    expect(accelerated).toEqual(pure);
  });
});
