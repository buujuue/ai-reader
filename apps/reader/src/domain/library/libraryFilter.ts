import type { ReadingMaterial } from './material';
import type { LibraryFolder } from './libraryFolder';

export interface LibraryTreeSearchResult {
  /** 去除首尾空白并按中文 locale 规则小写化后的查询。 */
  query: string;
  /** 文件夹名称直接命中的文件夹。 */
  matchingFolderIds: Set<string>;
  /** 标题或作者直接命中的材料。 */
  matchingMaterialIds: Set<string>;
  /** 搜索结果需要显示的文件夹,包含命中节点的祖先。 */
  visibleFolderIds: Set<string>;
  /** 搜索结果需要显示的材料。 */
  visibleMaterialIds: Set<string>;
  /** 为了展示搜索结果而临时展开的文件夹,不属于 Workspace State。 */
  autoExpandedFolderIds: Set<string>;
  /** 每份材料当前所属的完整书库路径,未归类使用“未归类”。 */
  materialFolderPaths: Map<string, string[]>;
}

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN');
}

function materialMatchesQuery(material: ReadingMaterial, query: string): boolean {
  return material.title.toLocaleLowerCase('zh-CN').includes(query) ||
    (material.author?.toLocaleLowerCase('zh-CN').includes(query) ?? false);
}

function getLibraryFolderPathFromIndex(
  folderId: string,
  byId: ReadonlyMap<string, LibraryFolder>,
): string[] {
  const path: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.name);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path;
}

/** 返回文件夹的完整显示路径;损坏的父级或循环数据会安全截断。 */
export function getLibraryFolderPath(
  folderId: string,
  folders: readonly LibraryFolder[],
): string[] {
  return getLibraryFolderPathFromIndex(
    folderId,
    new Map(folders.map((folder) => [folder.id, folder])),
  );
}

function includeAncestors(
  folderId: string,
  byId: ReadonlyMap<string, LibraryFolder>,
  target: Set<string>,
): void {
  const visited = new Set<string>();
  let current = byId.get(folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    target.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
}

/**
 * 基于「有效元数据」即时筛选书库。
 * 有效标题/作者已做过覆盖优先、来源兜底的合并,因此这里只需匹配 title 与 author,
 * 不关心覆盖值或来源快照的差异。匹配为大小写不敏感的子串匹配。
 */
export function filterMaterialsByQuery(
  materials: readonly ReadingMaterial[],
  query: string,
): ReadingMaterial[] {
  const trimmed = normalizeQuery(query);
  if (trimmed.length === 0) {
    return [...materials];
  }
  return materials.filter((material) => {
    return materialMatchesQuery(material, trimmed);
  });
}

/**
 * 计算书库树的搜索投影。
 *
 * 文件夹命中时保留该文件夹的整个子树,材料命中时只保留材料及其祖先;
 * 两种命中都只通过返回值表达临时展开,调用方不得把 autoExpandedFolderIds 写回工作区。
 */
export function buildLibraryTreeSearch(
  folders: readonly LibraryFolder[],
  materials: readonly ReadingMaterial[],
  query: string,
): LibraryTreeSearchResult {
  const normalizedQuery = normalizeQuery(query);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const childrenByParent = new Map<string, LibraryFolder[]>();
  for (const folder of folders) {
    if (folder.parentId === null || !byId.has(folder.parentId)) continue;
    const children = childrenByParent.get(folder.parentId) ?? [];
    children.push(folder);
    childrenByParent.set(folder.parentId, children);
  }

  const matchingFolderIds = new Set<string>();
  const matchingMaterialIds = new Set<string>();
  const visibleFolderIds = new Set<string>();
  const visibleMaterialIds = new Set<string>();
  const autoExpandedFolderIds = new Set<string>();
  const materialFolderPaths = new Map<string, string[]>();

  for (const material of materials) {
    const folderPath = material.folderId === null
      ? []
      : getLibraryFolderPathFromIndex(material.folderId, byId);
    materialFolderPaths.set(
      material.id,
      folderPath.length > 0 ? folderPath : ['未归类'],
    );
  }

  if (!normalizedQuery) {
    for (const folder of folders) visibleFolderIds.add(folder.id);
    for (const material of materials) visibleMaterialIds.add(material.id);
    return {
      query: '',
      matchingFolderIds,
      matchingMaterialIds,
      visibleFolderIds,
      visibleMaterialIds,
      autoExpandedFolderIds,
      materialFolderPaths,
    };
  }

  for (const folder of folders) {
    if (folder.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) {
      matchingFolderIds.add(folder.id);
    }
  }
  for (const material of materials) {
    if (materialMatchesQuery(material, normalizedQuery)) matchingMaterialIds.add(material.id);
  }

  const folderSearchScope = new Set<string>();
  const includeDescendants = (folderId: string, ancestors = new Set<string>()) => {
    if (ancestors.has(folderId) || folderSearchScope.has(folderId)) return;
    folderSearchScope.add(folderId);
    const nextAncestors = new Set(ancestors).add(folderId);
    for (const child of childrenByParent.get(folderId) ?? []) {
      includeDescendants(child.id, nextAncestors);
    }
  };
  for (const folderId of matchingFolderIds) includeDescendants(folderId);

  for (const folderId of folderSearchScope) {
    includeAncestors(folderId, byId, visibleFolderIds);
    includeAncestors(folderId, byId, autoExpandedFolderIds);
  }
  for (const material of materials) {
    if (matchingMaterialIds.has(material.id) || (material.folderId !== null && folderSearchScope.has(material.folderId))) {
      visibleMaterialIds.add(material.id);
      if (material.folderId !== null) {
        includeAncestors(material.folderId, byId, visibleFolderIds);
        if (matchingMaterialIds.has(material.id)) {
          includeAncestors(material.folderId, byId, autoExpandedFolderIds);
        }
      }
    }
  }

  return {
    query: normalizedQuery,
    matchingFolderIds,
    matchingMaterialIds,
    visibleFolderIds,
    visibleMaterialIds,
    autoExpandedFolderIds,
    materialFolderPaths,
  };
}
