import { invoke } from '@tauri-apps/api/core';

import type { TauriInvoke } from '../tauriInvoke';
import type { LibraryFolderRepository } from './libraryFolderRepository';
import type { LibraryFolder } from './libraryFolder';

export const LIBRARY_FOLDER_COMMAND_NAMES = {
  list: 'list_library_folders',
  create: 'create_library_folder',
  rename: 'rename_library_folder',
} as const;

function assertFolderShape(raw: unknown): LibraryFolder {
  const candidate = raw as Partial<LibraryFolder> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    (candidate.parentId !== null && typeof candidate.parentId !== 'string')
  ) {
    throw new Error('文件夹载荷格式错误');
  }
  return {
    id: candidate.id,
    name: candidate.name,
    parentId: candidate.parentId ?? null,
  };
}

function assertFolderList(raw: unknown): LibraryFolder[] {
  if (!Array.isArray(raw)) {
    throw new Error('文件夹列表载荷格式错误');
  }
  return raw.map(assertFolderShape);
}

export function createTauriLibraryFolderRepository(invokeFn: TauriInvoke): LibraryFolderRepository {
  return {
    async listFolders(): Promise<LibraryFolder[]> {
      return assertFolderList(await invokeFn(LIBRARY_FOLDER_COMMAND_NAMES.list));
    },
    async createFolder(name: string, parentId: string | null): Promise<LibraryFolder> {
      return assertFolderShape(
        await invokeFn(LIBRARY_FOLDER_COMMAND_NAMES.create, { name, parentId }),
      );
    },
    async renameFolder(folderId: string, name: string): Promise<LibraryFolder> {
      return assertFolderShape(
        await invokeFn(LIBRARY_FOLDER_COMMAND_NAMES.rename, { folderId, name }),
      );
    },
  };
}

export function createDefaultTauriLibraryFolderRepository(): LibraryFolderRepository {
  return createTauriLibraryFolderRepository((command, args) => invoke(command, args));
}
