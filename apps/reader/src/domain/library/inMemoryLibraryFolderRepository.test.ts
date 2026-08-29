import { describe, expect, it } from 'vitest';

import { libraryFolderRepositoryContract } from './libraryFolderRepository.contract';
import { createInMemoryLibraryFolderRepository } from './inMemoryLibraryFolderRepository';

describe('LibraryFolderRepository 契约 · 内存 Adapter', () => {
  libraryFolderRepositoryContract(() => createInMemoryLibraryFolderRepository());

  it('组合材料事务提交失败时回滚文件夹快照', async () => {
    const folder = { id: 'folder-1', name: '目标', parentId: null };
    let materialFolderId: string | null = folder.id;
    const repository = createInMemoryLibraryFolderRepository([folder], {
      prepareDeleteSubtree: () => ({
        commit() {
          materialFolderId = null;
          throw new Error('模拟材料提交失败');
        },
        rollback() {
          materialFolderId = folder.id;
        },
      }),
    });

    await expect(repository.deleteFolder(folder.id)).rejects.toThrow('模拟材料提交失败');
    expect(materialFolderId).toBe(folder.id);
    await expect(repository.listFolders()).resolves.toEqual([folder]);
  });
});
