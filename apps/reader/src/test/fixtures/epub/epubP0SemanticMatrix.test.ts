import { describe, expect, it } from 'vitest';

import { buildEpubFixture } from './epubFixtures';
import { openFoliateEpub } from '../../../domain/reader/foliateEpubLoader';

interface FoliateP0Book {
  dir?: string;
  rendition?: { layout?: string };
  toc?: Array<{ label?: string; href?: string }>;
  sections?: Array<{ id?: string; linear?: string }>;
}

function asFile(bytes: Uint8Array): File {
  return new File([
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  ], 'fixture.epub', { type: 'application/epub+zip' });
}

describe('EPUB P0 foliate 语义矩阵', () => {
  it('EPUB 2 的 NCX 和 EPUB 3 的 NAV 都提供可用目录与 spine', async () => {
    const epub2 = (await openFoliateEpub(
      asFile(await buildEpubFixture('epub2-ncx-flowable')),
    )) as FoliateP0Book;
    const epub3 = (await openFoliateEpub(
      asFile(await buildEpubFixture('epub3-nav-rich')),
    )) as FoliateP0Book;

    expect(epub2.toc?.[0]).toMatchObject({ label: '第一章' });
    expect(epub3.toc?.[0]).toMatchObject({ label: '第一章' });
    expect(epub2.sections).toHaveLength(1);
    expect(epub3.sections).toHaveLength(1);
  });

  it('固定版式和 RTL 方向由同一份 foliate Book 语义提供', async () => {
    const fixed = (await openFoliateEpub(
      asFile(await buildEpubFixture('epub3-fixed-layout')),
    )) as FoliateP0Book;
    const rtl = (await openFoliateEpub(
      asFile(await buildEpubFixture('epub3-rtl-vertical')),
    )) as FoliateP0Book;

    expect(fixed.rendition?.layout).toBe('pre-paginated');
    expect(rtl.dir).toBe('rtl');
    expect(rtl.sections).toHaveLength(1);
  });
});
