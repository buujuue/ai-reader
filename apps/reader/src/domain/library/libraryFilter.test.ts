import { describe, expect, it } from 'vitest';

import type { ReadingMaterial } from './material';
import { buildLibraryTreeSearch, filterMaterialsByQuery } from './libraryFilter';

function material(overrides: Partial<ReadingMaterial>): ReadingMaterial {
  return {
    id: 'id',
    fingerprint: 'f',
    sourceFileName: 'book.epub',
    folderId: null,
    source: { title: '来源', author: '来源作者', language: 'zh' },
    override: { title: null, author: null, coverSource: null },
    title: '来源',
    author: '来源作者',
    language: 'zh',
    coverSource: null,
    documentVersion: 0,
    ...overrides,
  };
}

describe('filterMaterialsByQuery', () => {
  it('空查询返回全部材料', () => {
    const list = [material({ title: '甲' }), material({ title: '乙' })];
    expect(filterMaterialsByQuery(list, '')).toEqual(list);
    expect(filterMaterialsByQuery(list, '   ')).toEqual(list);
  });

  it('按标题子串匹配(不区分大小写)', () => {
    const list = [material({ title: '三体' }), material({ title: '活着' })];
    expect(filterMaterialsByQuery(list, '三').map((m) => m.title)).toEqual(['三体']);
    expect(filterMaterialsByQuery(list, 'TITLE').length).toBe(0);
  });

  it('按作者子串匹配', () => {
    const list = [
      material({ title: '三体', author: '刘慈欣' }),
      material({ title: '活着', author: '余华' }),
    ];
    expect(filterMaterialsByQuery(list, '刘').map((m) => m.title)).toEqual(['三体']);
  });

  it('匹配使用有效元数据(覆盖优先)', () => {
    // ReadingMaterial.title 已是覆盖优先、来源兜底合并后的有效标题,overrides 仅用于记录覆盖本身。
    const list = [
      material({
        title: '整理标题',
        source: { title: '来源标题', author: '来源作者', language: 'zh' },
        override: { title: '整理标题', author: null, coverSource: null },
      }),
    ];
    expect(filterMaterialsByQuery(list, '整理').map((m) => m.title)).toEqual(['整理标题']);
    expect(filterMaterialsByQuery(list, '来源标题')).toEqual([]);
  });

  it('作者为 null 时不会匹配', () => {
    const list = [material({ author: null })];
    expect(filterMaterialsByQuery(list, '作者')).toEqual([]);
  });
});

describe('buildLibraryTreeSearch', () => {
  it('同时匹配文件夹、有效标题和作者,并保留命中材料的完整路径', () => {
    const folders = [
      { id: 'history', name: '历史', parentId: null },
      { id: 'europe', name: '欧洲', parentId: 'history' },
      { id: 'novels', name: '小说', parentId: null },
    ];
    const materials = [
      material({ id: 'book-title', title: '法国史', folderId: 'europe' }),
      material({ id: 'book-author', title: '战争与和平', author: '托尔斯泰', folderId: 'novels' }),
      material({ id: 'unfiled', title: '未归类读物', author: null, folderId: null }),
    ];

    const byFolder = buildLibraryTreeSearch(folders, materials, '欧洲');
    expect(byFolder.matchingFolderIds).toEqual(new Set(['europe']));
    expect(byFolder.visibleFolderIds).toEqual(new Set(['history', 'europe']));
    expect(byFolder.visibleMaterialIds).toEqual(new Set(['book-title']));
    expect(byFolder.autoExpandedFolderIds).toEqual(new Set(['history', 'europe']));

    const byAuthor = buildLibraryTreeSearch(folders, materials, '托尔斯泰');
    expect(byAuthor.matchingMaterialIds).toEqual(new Set(['book-author']));
    expect(byAuthor.visibleFolderIds).toEqual(new Set(['novels']));
    expect(byAuthor.materialFolderPaths.get('book-author')).toEqual(['小说']);
    expect(byAuthor.autoExpandedFolderIds).toEqual(new Set(['novels']));

    const unfiled = buildLibraryTreeSearch(folders, materials, '未归类读物');
    expect(unfiled.matchingMaterialIds).toEqual(new Set(['unfiled']));
    expect(unfiled.materialFolderPaths.get('unfiled')).toEqual(['未归类']);
  });

  it('空查询不隐藏材料或文件夹,且不产生临时展开', () => {
    const folders = [{ id: 'root', name: '根', parentId: null }];
    const materials = [material({ id: 'book', folderId: 'root' })];

    const result = buildLibraryTreeSearch(folders, materials, '  ');

    expect(result.query).toBe('');
    expect(result.visibleFolderIds).toEqual(new Set(['root']));
    expect(result.visibleMaterialIds).toEqual(new Set(['book']));
    expect(result.autoExpandedFolderIds).toEqual(new Set());
  });
});
