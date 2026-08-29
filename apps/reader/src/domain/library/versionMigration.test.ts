import { describe, expect, it } from 'vitest';

import type { Annotation } from '../annotation/annotation';
import type { BookDocument } from '../reader/bookDocument';
import { DEFAULT_WORKSPACE_STATE, type WorkspaceState } from '../workspace/workspaceState';
import {
  findVersionMigrationCandidates,
  metadataMatchKey,
  buildVersionMigrationPreview,
} from './versionMigration';
import type { ReadingMaterial, StagedImport } from './material';

function material(overrides: Partial<ReadingMaterial> = {}): ReadingMaterial {
  return {
    id: 'old-book',
    fingerprint: 'old-fingerprint',
    sourceFileName: 'book.epub',
    folderId: null,
    source: { title: '示例书', author: '作者', language: 'zh' },
    override: { title: null, author: null, coverSource: null },
    title: '示例书',
    author: '作者',
    language: 'zh',
    coverSource: null,
    documentVersion: 0,
    ...overrides,
  };
}

const staged: StagedImport = {
  id: 'staged-new',
  originalFileName: 'book-new.epub',
  fingerprint: 'new-fingerprint',
};

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'annotation-1',
    materialId: 'old-book',
    anchor: {
      cfi: 'epubcfi(/6/4[chapter-1])!/4/2/2/1:0',
      quote: '唯一引文',
      before: '前文',
      after: '后文',
      documentVersion: 'old-fingerprint',
      recoveryState: 'resolved',
    },
    style: 'highlight',
    color: '#ffd54f',
    note: '',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function documentFor(options: {
  resolvable?: Set<string>;
  matches?: Array<{ cfi: string; match: string; pre?: string; post?: string }>;
}): BookDocument {
  return {
    format: 'epub',
    metadata: { title: '新版本', author: '作者', language: 'zh' },
    async open() {},
    getLocation: () => null,
    async goToLocation() {},
    async goToHref() {},
    getTOC: () => [],
    search: async function* () {
      for (const match of options.matches ?? []) {
        yield {
          kind: 'match' as const,
          match: {
            cfi: match.cfi,
            excerpt: { pre: match.pre ?? '前文', match: match.match, post: match.post ?? '后文' },
          },
        };
      }
    },
    clearSearch() {},
    applyTypography() {},
    async next() {},
    async prev() {},
    getCFI: () => '',
    canResolveAnnotation: async (cfi) => options.resolvable?.has(cfi) ?? false,
    getCurrentIndex: () => 0,
    addAnnotation() {},
    removeAnnotation() {},
    onShowAnnotation: () => () => undefined,
    onInternalLink: () => () => undefined,
    onExternalLink: () => () => undefined,
    getContentDocs: () => [],
    onContentCreate: () => () => undefined,
    onLocationChange: () => () => undefined,
    close() {},
  };
}

describe('显式书籍版本迁移领域 seam', () => {
  it('只把 EPUB 的元数据匹配且完整指纹不同的材料列为候选，不自动合并', () => {
    const old = material();
    const sameBytes = material({ id: 'same-bytes', fingerprint: staged.fingerprint });
    const differentMetadata = material({ id: 'different', source: { title: '别的书', author: '作者', language: 'zh' } });
    const markdown = material({ id: 'markdown', sourceFileName: 'book.md' });

    expect(metadataMatchKey(old.source, old.sourceFileName)).toBe(
      metadataMatchKey({ title: ' 示例书 ', author: '作者', language: 'zh' }, staged.originalFileName),
    );
    expect(findVersionMigrationCandidates([old, sameBytes, differentMetadata, markdown], staged, old.source)).toEqual([
      old,
    ]);
  });

  it('预览保留原 CFI，并把唯一同章节引文标为重锚', async () => {
    const oldCfi = 'epubcfi(/6/4[chapter-1])!/4/2/2/1:0';
    const newCfi = 'epubcfi(/6/4[chapter-1])!/4/4/2/1:3';
    const state: WorkspaceState = {
      ...structuredClone(DEFAULT_WORKSPACE_STATE),
      editorGroups: [{
        id: 'group-1',
        activeViewId: 'view-1',
        views: [{
          id: 'view-1',
          materialId: 'old-book',
          location: { kind: 'epub', cfi: oldCfi },
          history: { positions: [{ kind: 'epub', cfi: oldCfi }], index: 0 },
          sourceMode: false,
        }],
      }],
    };
    const preview = await buildVersionMigrationPreview({
      candidate: { material: material(), staged, metadata: { title: '新版本', author: '作者', language: 'zh' } },
      document: documentFor({ matches: [{ cfi: newCfi, match: '唯一引文' }] }),
      annotations: [annotation()],
      deletedAnnotations: [annotation({ id: 'deleted-1', deletedAt: 8 })],
      workspaceState: state,
    });

    expect(preview.annotations.map((item) => item.outcome)).toEqual(['reanchored', 'reanchored']);
    expect(preview.annotations[0]?.matchCount).toBe(1);
    expect(preview.migratedAnnotations[0]?.anchor.cfi).toBe(newCfi);
    expect(preview.migratedAnnotations[1]?.deletedAt).toBe(8);
    expect(preview.progress[0]?.outcome).toBe('orphaned');
  });

  it('预览不跨章节猜测，并分别保留零匹配与多匹配结果', async () => {
    const anchor = annotation();
    const preview = await buildVersionMigrationPreview({
      candidate: { material: material(), staged, metadata: { title: '新版本', author: '作者', language: 'zh' } },
      document: documentFor({
        matches: [
          { cfi: 'epubcfi(/6/6[chapter-2])!/4/2/2/1:0', match: '唯一引文' },
          { cfi: 'epubcfi(/6/4[chapter-1])!/4/4/2/1:3', match: '唯一引文' },
          { cfi: 'epubcfi(/6/4[chapter-1])!/4/6/2/1:7', match: '唯一引文' },
        ],
      }),
      annotations: [anchor],
      deletedAnnotations: [],
      workspaceState: DEFAULT_WORKSPACE_STATE,
    });

    expect(preview.annotations[0]?.outcome).toBe('orphaned');
    expect(preview.annotations[0]?.matchCount).toBe(2);
    expect(preview.annotations[0]?.reason).toBe('multiple-matches');
  });
});
