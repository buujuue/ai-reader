import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryFilePicker } from '../app/filePicker';
import { createAppServices, type AppServices } from '../app/bootstrap';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { addInMemorySource, createInMemoryImportRepository } from '../domain/library/inMemoryImportRepository';
import { createInMemoryLibraryFolderRepository } from '../domain/library/inMemoryLibraryFolderRepository';
import { useLibraryStore } from './libraryStore';
import { useShellUiStore } from './shellUiStore';

describe('书库材料归类 Command', () => {
  let services: AppServices;

  beforeEach(async () => {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, 'book.md', new TextEncoder().encode('# 书'));
    const importRepository = createInMemoryImportRepository(sources);
    const folderRepository = createInMemoryLibraryFolderRepository();
    const folder = await folderRepository.createFolder('文史', null);
    const staged = await importRepository.stageImport('book.md');
    const material = await importRepository.commitImport(staged, {
      title: '书',
      author: null,
      language: 'zh',
    });
    useLibraryStore.getState().resetToDefault();
    useShellUiStore.getState().setStatusMessage('就绪');
    useLibraryStore.setState({ materials: [material], folders: [folder], trashedMaterials: [] });
    services = createAppServices({
      importRepository,
      filePicker: createInMemoryFilePicker([]),
      libraryFolderRepository: folderRepository,
    });
  });

  it('移动失败时不提前改写材料 Store', async () => {
    const move = vi.spyOn(services.importRepository, 'moveMaterialToFolder');
    move.mockRejectedValue(new Error('模拟平台写入失败'));

    await expect(
      services.commands.execute(
        COMMAND_IDS.libraryMoveMaterial,
        useLibraryStore.getState().materials[0]!.id,
        useLibraryStore.getState().folders[0]!.id,
      ),
    ).rejects.toThrow('模拟平台写入失败');

    expect(useLibraryStore.getState().materials[0]?.folderId).toBeNull();
  });
});
