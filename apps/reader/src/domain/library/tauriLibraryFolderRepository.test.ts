import { describe, expect, it } from 'vitest';

import type { TauriInvoke } from '../tauriInvoke';
import { libraryFolderRepositoryContract } from './libraryFolderRepository.contract';
import { createInMemoryLibraryFolderRepository } from './inMemoryLibraryFolderRepository';
import {
  createTauriLibraryFolderRepository,
  LIBRARY_FOLDER_COMMAND_NAMES,
} from './tauriLibraryFolderRepository';

function createFakeTauriBackend(): TauriInvoke {
  const backend = createInMemoryLibraryFolderRepository();
  return async (command, args) => {
    switch (command) {
      case LIBRARY_FOLDER_COMMAND_NAMES.list:
        return backend.listFolders();
      case LIBRARY_FOLDER_COMMAND_NAMES.create: {
        const payload = args as { name: string; parentId: string | null };
        return backend.createFolder(payload.name, payload.parentId);
      }
      case LIBRARY_FOLDER_COMMAND_NAMES.rename: {
        const payload = args as { folderId: string; name: string };
        return backend.renameFolder(payload.folderId, payload.name);
      }
      default:
        throw new Error(`unknown tauri command: ${command}`);
    }
  };
}

describe('LibraryFolderRepository 契约 · Tauri Adapter', () => {
  libraryFolderRepositoryContract(() => createTauriLibraryFolderRepository(createFakeTauriBackend()));
});

describe('TauriLibraryFolderRepository 边界映射', () => {
  it('使用稳定的 snake_case 命令和 camelCase 参数', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    const repository = createTauriLibraryFolderRepository(async (command, args) => {
      calls.push({ command, args });
      if (command === LIBRARY_FOLDER_COMMAND_NAMES.list) return [];
      return { id: 'folder-1', name: '阅读', parentId: null };
    });

    await repository.listFolders();
    await repository.createFolder('阅读', null);
    await repository.renameFolder('folder-1', '新名');

    expect(calls).toEqual([
      { command: 'list_library_folders', args: undefined },
      { command: 'create_library_folder', args: { name: '阅读', parentId: null } },
      { command: 'rename_library_folder', args: { folderId: 'folder-1', name: '新名' } },
    ]);
  });

  it('拒绝格式错误的 Rust 返回载荷', async () => {
    const repository = createTauriLibraryFolderRepository(async () => ({ id: 1 }));

    await expect(repository.listFolders()).rejects.toThrow('文件夹列表载荷格式错误');
  });
});
