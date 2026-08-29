import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppServices } from '../app/bootstrap';
import { AppServicesProvider } from '../app/AppServicesContext';
import { createInMemoryFilePicker } from '../app/filePicker';
import { createInMemoryImportRepository } from '../domain/library/inMemoryImportRepository';
import { createInMemoryLibraryFolderRepository } from '../domain/library/inMemoryLibraryFolderRepository';
import type { LibraryFolder } from '../domain/library/libraryFolder';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { FolderDeleteConfirmDialog } from './FolderDeleteConfirmDialog';

describe('FolderDeleteConfirmDialog', () => {
  beforeEach(() => {
    useLibraryStore.getState().resetToDefault();
    useShellUiStore.getState().closeFolderDeleteConfirm();
  });

  it('删除失败时保留确认框并显示可行动的中文错误', async () => {
    const folder: LibraryFolder = { id: 'folder-1', name: '目标', parentId: null };
    const folderRepository = createInMemoryLibraryFolderRepository([folder]);
    vi.spyOn(folderRepository, 'deleteFolder').mockRejectedValue(
      new Error('数据库写入失败,请重试'),
    );
    useLibraryStore.setState({ folders: [folder] });
    useShellUiStore.getState().openFolderDeleteConfirm(folder.id);
    const services = createAppServices({
      libraryFolderRepository: folderRepository,
      importRepository: createInMemoryImportRepository(),
      filePicker: createInMemoryFilePicker([]),
    });
    const user = userEvent.setup();

    render(
      <AppServicesProvider services={services}>
        <FolderDeleteConfirmDialog />
      </AppServicesProvider>,
    );

    await user.click(screen.getByRole('button', { name: '删除文件夹' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('数据库写入失败,请重试');
    });
    expect(screen.getByRole('dialog', { name: '删除书库文件夹' })).toBeInTheDocument();
    expect(await folderRepository.listFolders()).toEqual([folder]);
    expect(useShellUiStore.getState().statusMessage).toContain('删除文件夹失败');
  });
});
