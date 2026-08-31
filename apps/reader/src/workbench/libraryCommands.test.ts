import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryFilePicker } from '../app/filePicker';
import { createAppServices, type AppServices } from '../app/bootstrap';
import { COMMAND_IDS, CommandRegistry } from '../commands/commandRegistry';
import { addInMemorySource, createInMemoryImportRepository } from '../domain/library/inMemoryImportRepository';
import { createInMemoryLibraryFolderRepository } from '../domain/library/inMemoryLibraryFolderRepository';
import type { VersionMigrationPreview } from '../domain/library/versionMigration';
import { useLibraryStore } from './libraryStore';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';
import { registerLibraryCommands } from './libraryCommands';

describe('书库材料归类 Command', () => {
  let services: AppServices;

  beforeEach(async () => {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, 'book.md', new TextEncoder().encode('# 书'));
    addInMemorySource(sources, 'book-2.md', new TextEncoder().encode('# 另一书'));
    const importRepository = createInMemoryImportRepository(sources);
    const folderRepository = createInMemoryLibraryFolderRepository([], {
      prepareDeleteSubtree: (folderIds) =>
        importRepository.prepareClearMaterialFolderAssignments(folderIds),
    });
    const folder = await folderRepository.createFolder('文史', null);
    const staged = await importRepository.stageImport('book.md');
    const material = await importRepository.commitImport(staged, {
      title: '书',
      author: null,
      language: 'zh',
    });
    const stagedSecond = await importRepository.stageImport('book-2.md');
    const secondMaterial = await importRepository.commitImport(stagedSecond, {
      title: '另一书',
      author: null,
      language: 'zh',
    });
    useLibraryStore.getState().resetToDefault();
    useShellUiStore.getState().setStatusMessage('就绪');
    useWorkspaceStore.getState().resetToDefault();
    useLibraryStore.setState({ materials: [material, secondMaterial], folders: [folder], trashedMaterials: [] });
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

  it('刷新书库时安全忽略并清理不存在的文件夹展开 ID', async () => {
    const root = useLibraryStore.getState().folders[0]!;
    const persisted = await services.workspaceRepository.loadState();
    await services.workspaceRepository.saveState({
      ...persisted,
      expandedLibraryFolderIds: [root.id, 'folder-deleted'],
    });
    useWorkspaceStore.getState().hydrate(await services.workspaceRepository.loadState());

    await services.commands.execute(COMMAND_IDS.libraryRefresh);

    expect(useWorkspaceStore.getState().expandedLibraryFolderIds).toEqual([root.id]);
    await expect(services.workspaceRepository.loadState()).resolves.toMatchObject({
      expandedLibraryFolderIds: [root.id],
    });
  });

  it('递归删除文件夹后把活跃及回收站材料转为未归类并清理展开状态', async () => {
    const root = useLibraryStore.getState().folders[0]!;
    const child = await services.libraryFolderRepository.createFolder('子级', root.id);
    const [active, trashed] = useLibraryStore.getState().materials;
    await services.importRepository.moveMaterialToFolder(active!.id, child.id);
    await services.importRepository.moveMaterialToFolder(trashed!.id, child.id);
    const trashedMaterial = await services.importRepository.trashMaterial(trashed!.id);
    useLibraryStore.setState({
      materials: [await services.importRepository.listMaterials().then((items) => items.find((item) => item.id === active!.id)!)],
      trashedMaterials: [trashedMaterial],
      folders: await services.libraryFolderRepository.listFolders(),
    });
    useWorkspaceStore.getState().openView(active!.id);
    useWorkspaceStore.getState().setLibraryFolderExpanded(root.id, true);
    useWorkspaceStore.getState().setLibraryFolderExpanded(child.id, true);

    await services.commands.execute(COMMAND_IDS.libraryDeleteFolder, root.id);

    expect(await services.libraryFolderRepository.listFolders()).toEqual([]);
    expect((await services.importRepository.listMaterials())[0]?.folderId).toBeNull();
    expect((await services.importRepository.listTrashed())[0]?.folderId).toBeNull();
    expect(useLibraryStore.getState().materials[0]?.folderId).toBeNull();
    expect(useLibraryStore.getState().trashedMaterials[0]?.folderId).toBeNull();
    expect(useWorkspaceStore.getState().expandedLibraryFolderIds).toEqual([]);
    expect(useWorkspaceStore.getState().editorGroups[0]?.views).toHaveLength(1);
    expect(useWorkspaceStore.getState().primaryMaterialId).toBe(active!.id);
  });

  it('文件夹删除失败时不改变文件夹、材料或展开状态', async () => {
    const root = useLibraryStore.getState().folders[0]!;
    const material = useLibraryStore.getState().materials[0]!;
    await services.importRepository.moveMaterialToFolder(material.id, root.id);
    useLibraryStore.setState({
      materials: [await services.importRepository.listMaterials().then((items) => items[0]!)],
    });
    useWorkspaceStore.getState().setLibraryFolderExpanded(root.id, true);
    vi.spyOn(services.libraryFolderRepository, 'deleteFolder').mockRejectedValue(
      new Error('模拟 SQLite 事务失败'),
    );

    await expect(
      services.commands.execute(COMMAND_IDS.libraryDeleteFolder, root.id),
    ).rejects.toThrow('模拟 SQLite 事务失败');
    expect(await services.libraryFolderRepository.listFolders()).toEqual([root]);
    expect((await services.importRepository.listMaterials())[0]?.folderId).toBe(root.id);
    expect(useLibraryStore.getState().materials[0]?.folderId).toBe(root.id);
    expect(useWorkspaceStore.getState().expandedLibraryFolderIds).toEqual([root.id]);
    await expect(services.workspaceRepository.loadState()).resolves.toMatchObject({
      expandedLibraryFolderIds: [root.id],
    });
  });

  it('展开状态预写失败时不执行文件夹删除', async () => {
    const root = useLibraryStore.getState().folders[0]!;
    useWorkspaceStore.getState().setLibraryFolderExpanded(root.id, true);
    const deleteFolder = vi.spyOn(services.libraryFolderRepository, 'deleteFolder');
    vi.spyOn(services.workspaceRepository, 'saveState').mockRejectedValueOnce(
      new Error('模拟工作区写入失败'),
    );

    await expect(
      services.commands.execute(COMMAND_IDS.libraryDeleteFolder, root.id),
    ).rejects.toThrow('模拟工作区写入失败');
    expect(deleteFolder).not.toHaveBeenCalled();
    expect(await services.libraryFolderRepository.listFolders()).toEqual([root]);
    expect(useWorkspaceStore.getState().expandedLibraryFolderIds).toEqual([root.id]);
  });

  it('移入回收站后使挂起 Runtime 失效但不关闭当前活动视图', async () => {
    const material = useLibraryStore.getState().materials[0]!;
    const invalidateMaterialRuntime = vi.fn(async () => undefined);
    const registry = new CommandRegistry();
    registerLibraryCommands(registry, {
      importRepository: services.importRepository,
      filePicker: createInMemoryFilePicker([]),
      libraryFolderRepository: services.libraryFolderRepository,
      invalidateMaterialRuntime,
    });

    await registry.execute(COMMAND_IDS.libraryTrash, material.id);

    expect(invalidateMaterialRuntime).toHaveBeenCalledWith(material.id, { includeActive: false });
    expect(useLibraryStore.getState().materials.some((item) => item.id === material.id)).toBe(false);
    expect(useLibraryStore.getState().trashedMaterials.some((item) => item.id === material.id)).toBe(true);
  });

  it('永久清理、重新关联和版本迁移都先失效旧 Runtime 再按当前材料重建', async () => {
    const [purgeTarget, relinkTarget] = useLibraryStore.getState().materials;
    const invalidateMaterialRuntime = vi.fn(async () => undefined);
    const reloadMaterialViews = vi.fn(async () => undefined);
    const registry = new CommandRegistry();
    registerLibraryCommands(registry, {
      importRepository: services.importRepository,
      filePicker: createInMemoryFilePicker(['book-2.md']),
      libraryFolderRepository: services.libraryFolderRepository,
      workspaceRepository: services.workspaceRepository,
      annotationRepository: services.annotationRepository,
      invalidateMaterialRuntime,
      reloadMaterialViews,
      syncVersionMigrationState: false,
    });

    const trashed = await services.importRepository.trashMaterial(purgeTarget!.id);
    useLibraryStore.setState({
      materials: [relinkTarget!],
      trashedMaterials: [trashed],
    });
    useWorkspaceStore.getState().openView(purgeTarget!.id);
    await registry.execute(COMMAND_IDS.libraryPurge, purgeTarget!.id);
    expect(invalidateMaterialRuntime).toHaveBeenCalledWith(purgeTarget!.id);
    expect(useWorkspaceStore.getState().editorGroups[0]?.views).toHaveLength(0);

    await registry.execute(COMMAND_IDS.libraryRelink, relinkTarget!.id);
    expect(reloadMaterialViews).toHaveBeenCalledWith(relinkTarget!.id);

    const staged = await services.importRepository.stageImport('book.md');
    const workspaceState = await services.workspaceRepository.loadState();
    const migratedMaterial = {
      ...relinkTarget!,
      fingerprint: staged.fingerprint,
      sourceFileName: staged.originalFileName,
    };
    vi.spyOn(services.importRepository, 'commitVersionMigration').mockResolvedValueOnce({
      material: migratedMaterial,
      snapshotId: 'snapshot-1',
    });
    const preview: VersionMigrationPreview = {
      candidate: {
        material: relinkTarget!,
        staged,
        metadata: relinkTarget!.source,
        sourceCover: null,
      },
      progress: [],
      annotations: [],
      summary: { kept: 0, reanchored: 0, orphaned: 0, total: 0 },
      migratedAnnotations: [],
      migratedWorkspaceState: workspaceState,
      sourceAnnotations: [],
      sourceWorkspaceState: workspaceState,
    };
    useShellUiStore.getState().setVersionMigrationPreview(preview);
    await registry.execute(COMMAND_IDS.libraryCommitVersionMigration, preview);
    expect(invalidateMaterialRuntime).toHaveBeenCalledWith(relinkTarget!.id);
    expect(reloadMaterialViews).toHaveBeenCalledWith(relinkTarget!.id);

    vi.spyOn(services.importRepository, 'restoreVersionMigrationSnapshot').mockResolvedValueOnce({
      material: relinkTarget!,
      annotations: [],
      workspaceState,
    });
    await registry.execute(COMMAND_IDS.libraryRestoreVersionMigrationSnapshot, 'snapshot-1');
    expect(invalidateMaterialRuntime).toHaveBeenLastCalledWith(relinkTarget!.id);
    expect(reloadMaterialViews).toHaveBeenLastCalledWith(relinkTarget!.id);
  });
});
