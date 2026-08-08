import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandRegistry, COMMAND_IDS } from '../commands/commandRegistry';
import type { FilePicker } from '../app/filePicker';
import type { ImportRepository } from '../domain/library/importRepository';
import { createInMemoryImportRepository } from '../domain/library/inMemoryImportRepository';
import { registerLibraryCommands } from './libraryCommands';
import { useLibraryStore } from './libraryStore';
import { useShellUiStore } from './shellUiStore';

function makeDeps(overrides: Partial<ImportBookDeps> = {}) {
  const importRepository = createInMemoryImportRepository();
  const filePicker: FilePicker = {
    pickBooks: async () => null,
    pickImage: async () => null,
  };
  return { importRepository, filePicker, ...overrides };
}

interface ImportBookDeps {
  importRepository: ImportRepository;
  filePicker: FilePicker;
}

async function seedOne(repository: ImportRepository) {
  return repository.commitImport(
    { id: 'mat-1', originalFileName: 'book.epub', fingerprint: 'f1' },
    { title: '来源标题', author: '来源作者', language: 'zh' },
  );
}

describe('元数据覆盖命令', () => {
  beforeEach(() => {
    useLibraryStore.getState().resetToDefault();
    useShellUiStore.getState().clearStatusMessage();
  });

  it('updateMetadata 用平台返回的权威结果更新书库', async () => {
    const deps = makeDeps();
    const registry = new CommandRegistry();
    const material = await seedOne(deps.importRepository);
    useLibraryStore.getState().setMaterials([material]);
    registerLibraryCommands(registry, deps);

    await registry.execute(COMMAND_IDS.libraryUpdateMetadata, material.id, '整理标题', '整理作者');

    const updated = useLibraryStore.getState().materials[0];
    expect(updated?.title).toBe('整理标题');
    expect(updated?.author).toBe('整理作者');
    expect(updated?.source.title).toBe('来源标题');
    expect(useShellUiStore.getState().statusMessage).toMatch(/已保存/);
  });

  it('写入失败时书库不被部分更新(不会只改界面而未持久化)', async () => {
    const failing = createInMemoryImportRepository();
    const spy = vi.spyOn(failing, 'applyMaterialMetadata').mockRejectedValueOnce(new Error('磁盘错误'));
    const deps = makeDeps({ importRepository: failing });
    const registry = new CommandRegistry();
    useLibraryStore.getState().setMaterials([await seedOne(failing)]);
    registerLibraryCommands(registry, deps);

    await expect(
      registry.execute(COMMAND_IDS.libraryUpdateMetadata, 'mat-1', '整理标题', '整理作者'),
    ).rejects.toThrow('磁盘错误');

    expect(useLibraryStore.getState().materials[0]?.title).toBe('来源标题');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('setCover 在用户取消选择时是空操作', async () => {
    const deps = makeDeps();
    const registry = new CommandRegistry();
    useLibraryStore.getState().setMaterials([await seedOne(deps.importRepository)]);
    registerLibraryCommands(registry, deps);

    await registry.execute(COMMAND_IDS.librarySetCover, 'mat-1');

    expect(useLibraryStore.getState().materials[0]?.coverSource).toBeNull();
  });

  it('空串与 null 一样清除该覆盖并回落到来源', async () => {
    const deps = makeDeps();
    const registry = new CommandRegistry();
    const material = await seedOne(deps.importRepository);
    await deps.importRepository.applyMaterialMetadata(material.id, '整理标题', '整理作者');
    useLibraryStore.getState().setMaterials(await deps.importRepository.listMaterials());
    registerLibraryCommands(registry, deps);

    await registry.execute(COMMAND_IDS.libraryUpdateMetadata, material.id, '', '');

    const updated = useLibraryStore.getState().materials[0];
    expect(updated?.title).toBe('来源标题');
    expect(updated?.author).toBe('来源作者');
    expect(updated?.override.title).toBeNull();
  });

  it('restoreMetadata 一键恢复来源元数据', async () => {
    const deps = makeDeps();
    const registry = new CommandRegistry();
    const material = await seedOne(deps.importRepository);
    await deps.importRepository.applyMaterialMetadata(material.id, '整理标题', null);
    useLibraryStore.getState().setMaterials(await deps.importRepository.listMaterials());
    registerLibraryCommands(registry, deps);

    await registry.execute(COMMAND_IDS.libraryRestoreMetadata, material.id);

    expect(useLibraryStore.getState().materials[0]?.title).toBe('来源标题');
    expect(useShellUiStore.getState().statusMessage).toMatch(/恢复来源元数据/);
  });
});