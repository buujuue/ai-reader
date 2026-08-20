import { describe, expect, it } from 'vitest';

import { getEpubCfiSpinePrefix, isSameEpubCfiSpine } from './epubCfi';

describe('EPUB CFI spine', () => {
  it('提取章节前缀而不受章节内路径影响', () => {
    expect(getEpubCfiSpinePrefix('epubcfi(/6/4!/4/2/2/1:0)')).toBe('/6/4');
    expect(getEpubCfiSpinePrefix('epubcfi(/6/4)')).toBe('/6/4');
  });

  it('只有同一 spine 章节的 CFI 才视为同章', () => {
    expect(
      isSameEpubCfiSpine(
        'epubcfi(/6/4!/4/2:0)',
        'epubcfi(/6/4!/4/8:0)',
      ),
    ).toBe(true);
    expect(
      isSameEpubCfiSpine(
        'epubcfi(/6/4!/4/2:0)',
        'epubcfi(/6/5!/4/2:0)',
      ),
    ).toBe(false);
    expect(isSameEpubCfiSpine('not-a-cfi', 'epubcfi(/6/4)')).toBe(false);
  });
});
