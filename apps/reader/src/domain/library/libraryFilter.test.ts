import { describe, expect, it } from 'vitest';

import type { ReadingMaterial } from './material';
import { filterMaterialsByQuery } from './libraryFilter';

function material(overrides: Partial<ReadingMaterial>): ReadingMaterial {
  return {
    id: 'id',
    fingerprint: 'f',
    sourceFileName: 'book.epub',
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