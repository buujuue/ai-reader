import type { LibraryFolderRepository } from './libraryFolderRepository';
import {
  sortLibraryFolders,
  validateNewLibraryFolder,
  validateRenamedLibraryFolder,
  type LibraryFolder,
} from './libraryFolder';

/** 浏览器降级与前端测试使用的文件夹 Repository。 */
export function createInMemoryLibraryFolderRepository(
  initialFolders: readonly LibraryFolder[] = [],
): LibraryFolderRepository {
  const folders = new Map<string, LibraryFolder>(
    initialFolders.map((folder) => [folder.id, structuredClone(folder)]),
  );

  return {
    async listFolders(): Promise<LibraryFolder[]> {
      return sortLibraryFolders([...folders.values()]).map((folder) => structuredClone(folder));
    },
    async createFolder(name: string, parentId: string | null): Promise<LibraryFolder> {
      const normalized = validateNewLibraryFolder(name, parentId, [...folders.values()]);
      const folder: LibraryFolder = {
        id: crypto.randomUUID(),
        name: normalized,
        parentId,
      };
      folders.set(folder.id, folder);
      return structuredClone(folder);
    },
    async renameFolder(folderId: string, name: string): Promise<LibraryFolder> {
      const current = folders.get(folderId);
      if (!current) {
        throw new Error('文件夹不存在,请刷新书库后重试');
      }
      const normalized = validateRenamedLibraryFolder(name, folderId, [...folders.values()]);
      const updated = { ...current, name: normalized };
      folders.set(folderId, updated);
      return structuredClone(updated);
    },
  };
}
