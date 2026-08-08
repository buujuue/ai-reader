import type { ReadingMaterial } from './material';

/**
 * 基于「有效元数据」即时筛选书库。
 * 有效标题/作者已做过覆盖优先、来源兜底的合并,因此这里只需匹配 title 与 author,
 * 不关心覆盖值或来源快照的差异。匹配为大小写不敏感的子串匹配。
 */
export function filterMaterialsByQuery(
  materials: ReadingMaterial[],
  query: string,
): ReadingMaterial[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return materials;
  }
  return materials.filter((material) => {
    if (material.title.toLowerCase().includes(trimmed)) {
      return true;
    }
    return material.author !== null && material.author.toLowerCase().includes(trimmed);
  });
}