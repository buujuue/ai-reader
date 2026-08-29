/** 书库文件夹的稳定领域模型与名称/层级规则。 */

export const MAX_LIBRARY_FOLDER_DEPTH = 5;

export interface LibraryFolder {
  /** 文件夹独立稳定身份,不由名称或路径推导。 */
  id: string;
  name: string;
  /** null 表示顶层文件夹。创建后父级不可变。 */
  parentId: string | null;
}

/** 用于同级唯一性判断的大小写不敏感名称键。 */
export function libraryFolderNameKey(name: string): string {
  return name.toLowerCase();
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => /\p{Cc}/u.test(character));
}

/** 清理并校验用户输入的文件夹名称,错误文案可直接展示给用户。 */
export function normalizeLibraryFolderName(name: string): string {
  if (hasControlCharacter(name)) {
    throw new Error('文件夹名称不能包含控制字符,请删除不可见字符');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('文件夹名称不能为空,请输入名称');
  }
  if (Array.from(trimmed).length > 80) {
    throw new Error('文件夹名称最多 80 个字符,请缩短名称');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('文件夹名称不能包含路径分隔符,请使用普通名称');
  }
  return trimmed;
}

function findFolder(folderId: string, folders: readonly LibraryFolder[]): LibraryFolder {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) {
    throw new Error('父文件夹不存在,请刷新书库后重试');
  }
  return folder;
}

/** 返回已有文件夹的 1-based 深度。 */
export function getLibraryFolderDepth(
  folderId: string,
  folders: readonly LibraryFolder[],
): number {
  let current = findFolder(folderId, folders);
  let depth = 1;
  const visited = new Set<string>();
  while (current.parentId !== null) {
    if (visited.has(current.id)) {
      throw new Error('文件夹层级数据存在循环,请修复书库后重试');
    }
    visited.add(current.id);
    current = findFolder(current.parentId, folders);
    depth += 1;
  }
  return depth;
}

function hasSiblingName(
  name: string,
  parentId: string | null,
  folders: readonly LibraryFolder[],
  excludedId?: string,
): boolean {
  const nameKey = libraryFolderNameKey(name);
  return folders.some(
    (folder) =>
      folder.id !== excludedId &&
      folder.parentId === parentId &&
      libraryFolderNameKey(folder.name) === nameKey,
  );
}

/** 校验并返回可持久化的新文件夹名称。 */
export function validateNewLibraryFolder(
  name: string,
  parentId: string | null,
  folders: readonly LibraryFolder[],
): string {
  const normalized = normalizeLibraryFolderName(name);
  if (parentId !== null) {
    const parentDepth = getLibraryFolderDepth(parentId, folders);
    if (parentDepth >= MAX_LIBRARY_FOLDER_DEPTH) {
      throw new Error(`已达到最多五层,无法在“${findFolder(parentId, folders).name}”下继续新建`);
    }
  }
  if (hasSiblingName(normalized, parentId, folders)) {
    throw new Error('同一父级下已有同名文件夹,请换一个名称');
  }
  return normalized;
}

/** 校验并返回改名后的名称;父级始终沿用原记录。 */
export function validateRenamedLibraryFolder(
  name: string,
  folderId: string,
  folders: readonly LibraryFolder[],
): string {
  const current = findFolder(folderId, folders);
  const normalized = normalizeLibraryFolderName(name);
  if (hasSiblingName(normalized, current.parentId, folders, folderId)) {
    throw new Error('同一父级下已有同名文件夹,请换一个名称');
  }
  return normalized;
}

function compareStrings(left: string, right: string): number {
  const leftKey = libraryFolderNameKey(left);
  const rightKey = libraryFolderNameKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

/** 按名称排序,同名时以稳定 ID 打破平局,不修改输入数组。 */
export function sortLibraryFolders(folders: readonly LibraryFolder[]): LibraryFolder[] {
  return [...folders].sort((left, right) => compareStrings(left.name, right.name) || left.id.localeCompare(right.id));
}

/** 根据当前权威文件夹快照收集目标及其后代,用于清理工作区展开状态。 */
export function collectLibraryFolderSubtreeIds(
  folderId: string,
  folders: readonly LibraryFolder[],
): string[] {
  if (!folders.some((folder) => folder.id === folderId)) return [folderId];
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.parentId === null) continue;
    const children = childrenByParent.get(folder.parentId) ?? [];
    children.push(folder.id);
    childrenByParent.set(folder.parentId, children);
  }

  const subtree: string[] = [];
  const visit = (currentId: string, ancestors: Set<string>) => {
    if (ancestors.has(currentId)) throw new Error('文件夹层级数据存在循环,请刷新书库后重试');
    subtree.push(currentId);
    const nextAncestors = new Set(ancestors).add(currentId);
    for (const childId of childrenByParent.get(currentId) ?? []) {
      visit(childId, nextAncestors);
    }
  };
  visit(folderId, new Set());
  return subtree;
}
