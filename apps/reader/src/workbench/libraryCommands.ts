import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import { EpubBookDocument } from '../domain/reader/epubBookDocument';
import {
  createFoliateViewHostFactory,
  type FoliateViewHostFactory,
} from '../domain/reader/foliateViewHost';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import type { LibraryFolderRepository } from '../domain/library/libraryFolderRepository';
import { collectLibraryFolderSubtreeIds } from '../domain/library/libraryFolder';
import type { StagedImport } from '../domain/library/material';
import { serializeWorkspaceState } from './workbenchCommands';
import { useAnnotationStore } from './annotationStore';
import { useLibraryStore } from './libraryStore';
import { useMarkdownSessionStore } from './markdownSessionStore';
import { useReaderRuntime } from './readerRuntime';
import { importBooks, type ImportBookDependencies } from './importBook';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';
import {
  buildVersionMigrationPreview,
  type VersionMigrationCandidate,
  type VersionMigrationPreview,
} from '../domain/library/versionMigration';

/** 空串与 null 都归一为 null(清除覆盖并回落到来源),避免把空覆盖钉住。 */
function normalizeOverrideValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function commandErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return fallback;
}

/** 书库相关的稳定 Command 唯一实现入口。TS 只经 typed ImportRepository 调用平台能力。 */
export function registerLibraryCommands(
  registry: CommandRegistry,
  dependencies: ImportBookDependencies & {
    annotationRepository?: AnnotationRepository;
    workspaceRepository?: WorkspaceRepository;
    libraryFolderRepository?: LibraryFolderRepository;
    viewHostFactory?: FoliateViewHostFactory;
    /** 浏览器降级适配器没有 Rust 的跨仓储原子事务，需要在提交后同步状态。 */
    syncVersionMigrationState?: boolean;
    /** Tauri 恢复/提交后重建活动 Reader Runtime，避免继续显示旧 EPUB 字节。 */
    reloadApplication?: () => void;
    /** 浏览器降级模式重建当前材料视图，不依赖整页刷新。 */
    reloadMaterialViews?: (materialId: string) => Promise<void>;
  },
): void {
  registry.register(COMMAND_IDS.libraryRefresh, async () => {
    const [materials, trashedMaterials, folders] = await Promise.all([
      dependencies.importRepository.listMaterials(),
      dependencies.importRepository.listTrashed(),
      dependencies.libraryFolderRepository?.listFolders() ?? Promise.resolve([]),
    ]);
    useLibraryStore.getState().setMaterials(materials);
    useLibraryStore.getState().setTrashedMaterials(trashedMaterials);
    useLibraryStore.getState().setFolders(folders);
  });

  registry.register(COMMAND_IDS.libraryCreateFolder, async (...args: unknown[]) => {
    const repository = dependencies.libraryFolderRepository;
    if (!repository) throw new Error('书库文件夹 Repository 未配置');
    const name = args[0];
    const parentId = args[1];
    if (typeof name !== 'string') throw new Error('新建文件夹命令缺少名称');
    if (parentId !== null && typeof parentId !== 'string') {
      throw new Error('新建文件夹命令的父级不合法');
    }
    const folder = await repository.createFolder(name, parentId as string | null);
    useLibraryStore.getState().setFolders(await repository.listFolders());
    useShellUiStore.getState().setStatusMessage(`已创建文件夹:${folder.name}`);
    return folder;
  });

  registry.register(COMMAND_IDS.libraryRenameFolder, async (...args: unknown[]) => {
    const repository = dependencies.libraryFolderRepository;
    if (!repository) throw new Error('书库文件夹 Repository 未配置');
    const folderId = args[0];
    const name = args[1];
    if (typeof folderId !== 'string' || folderId.length === 0) {
      throw new Error('重命名文件夹命令缺少文件夹 ID');
    }
    if (typeof name !== 'string') throw new Error('重命名文件夹命令缺少名称');
    const folder = await repository.renameFolder(folderId, name);
    useLibraryStore.getState().setFolders(await repository.listFolders());
    useShellUiStore.getState().setStatusMessage(`已重命名文件夹:${folder.name}`);
    return folder;
  });

  registry.register(COMMAND_IDS.libraryDeleteFolder, async (...args: unknown[]) => {
    const repository = dependencies.libraryFolderRepository;
    if (!repository) throw new Error('书库文件夹 Repository 未配置');
    const folderId = args[0];
    if (typeof folderId !== 'string' || folderId.length === 0) {
      throw new Error('删除文件夹命令缺少文件夹 ID');
    }

    const folder = useLibraryStore.getState().folders.find((item) => item.id === folderId);
    const previousExpandedFolderIds = [...useWorkspaceStore.getState().expandedLibraryFolderIds];
    const subtreeIds = collectLibraryFolderSubtreeIds(
      folderId,
      useLibraryStore.getState().folders,
    );
    const subtreeIdSet = new Set(subtreeIds);
    const knownFolderIds = new Set(useLibraryStore.getState().folders.map((item) => item.id));
    const nextExpandedFolderIds = previousExpandedFolderIds.filter(
      (id) => knownFolderIds.has(id) && !subtreeIdSet.has(id),
    );
    const workspaceNeedsSave =
      dependencies.workspaceRepository !== undefined &&
      nextExpandedFolderIds.length !== previousExpandedFolderIds.length;
    let workspacePrepared = false;

    try {
      if (workspaceNeedsSave) {
        await dependencies.workspaceRepository!.saveState({
          ...serializeWorkspaceState(),
          expandedLibraryFolderIds: nextExpandedFolderIds,
        });
        workspacePrepared = true;
      }

      const result = await repository.deleteFolder(folderId);
      if (!result.deletedFolderIds.includes(folderId)) {
        throw new Error('文件夹删除结果无效,请刷新书库后重试');
      }

      const deletedFolderIds = new Set(result.deletedFolderIds);
      useLibraryStore.setState((state) => ({
        folders: state.folders.filter((item) => !deletedFolderIds.has(item.id)),
        materials: state.materials.map((material) =>
          material.folderId !== null && deletedFolderIds.has(material.folderId)
            ? { ...material, folderId: null }
            : material,
        ),
        trashedMaterials: state.trashedMaterials.map((material) =>
          material.folderId !== null && deletedFolderIds.has(material.folderId)
            ? { ...material, folderId: null }
            : material,
        ),
      }));
      useWorkspaceStore.getState().removeLibraryFolderIds(result.deletedFolderIds);

      const folderLabel = folder?.name ?? '目标文件夹';
      useShellUiStore.getState().setStatusMessage(
        `已删除文件夹“${folderLabel}”,其中材料已转为未归类`,
      );
      return result;
    } catch (error: unknown) {
      if (workspacePrepared) {
        try {
          await dependencies.workspaceRepository!.saveState({
            ...serializeWorkspaceState(),
            expandedLibraryFolderIds: previousExpandedFolderIds,
          });
        } catch (rollbackError: unknown) {
          throw new Error(
            `删除文件夹失败:${commandErrorMessage(error, '请重试')}; 工作区状态回滚失败:${commandErrorMessage(rollbackError, '请重启应用后重试')}`,
          );
        }
      }
      throw error;
    }
  });

  registry.register(COMMAND_IDS.libraryMoveMaterial, async (...args: unknown[]) => {
    const materialId = args[0];
    const folderId = args[1];
    if (typeof materialId !== 'string' || materialId.length === 0) {
      throw new Error('移动材料命令缺少材料 ID');
    }
    if (folderId !== null && typeof folderId !== 'string') {
      throw new Error('移动材料命令的目标文件夹不合法');
    }

    // 目标来自书库树，但 Command 仍重新读取权威文件夹列表，避免过期 UI
    // 把材料写入已删除的 FolderId。Repository 只在这一步成功后才更新 Store。
    let targetFolderName: string | null = null;
    if (folderId !== null) {
      const folders = await dependencies.libraryFolderRepository?.listFolders() ?? [];
      const targetFolder = folders.find((folder) => folder.id === folderId);
      if (!targetFolder) {
        throw new Error('目标文件夹不存在,请刷新书库后重试');
      }
      targetFolderName = targetFolder.name;
    }

    const previous = useLibraryStore
      .getState()
      .materials.find((material) => material.id === materialId);
    const updated = await dependencies.importRepository.moveMaterialToFolder(
      materialId,
      folderId as string | null,
    );
    useLibraryStore.getState().updateMaterial(updated);
    const targetLabel = targetFolderName ?? '未归类';
    useShellUiStore.getState().setStatusMessage(
      previous?.folderId === (folderId as string | null)
        ? `${updated.title}已在“${targetLabel}”`
        : `已将${updated.title}移动到“${targetLabel}”`,
    );
    return updated;
  });

  registry.register(COMMAND_IDS.libraryUpdateMetadata, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    const rawTitle = (args[1] as string | null | undefined) ?? null;
    const rawAuthor = (args[2] as string | null | undefined) ?? null;
    if (!materialId) {
      throw new Error('更新元数据命令缺少材料 ID');
    }
    // 空串与 null 都表示清除该覆盖并回落到来源,避免把空覆盖钉住。
    const title = normalizeOverrideValue(rawTitle);
    const author = normalizeOverrideValue(rawAuthor);
    const updated = await dependencies.importRepository.applyMaterialMetadata(
      materialId,
      title,
      author,
    );
    useLibraryStore.getState().updateMaterial(updated);
    useShellUiStore.getState().setStatusMessage('已保存标题与作者');
  });

  registry.register(COMMAND_IDS.librarySetCover, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) {
      throw new Error('设置封面命令缺少材料 ID');
    }
    const sourcePath = await dependencies.filePicker.pickImage();
    if (sourcePath === null) {
      return;
    }
    const updated = await dependencies.importRepository.setMaterialCover(materialId, sourcePath);
    useLibraryStore.getState().updateMaterial(updated);
    useShellUiStore.getState().setStatusMessage('已设置自定义封面');
  });

  registry.register(COMMAND_IDS.libraryRemoveCover, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) {
      throw new Error('移除封面命令缺少材料 ID');
    }
    const updated = await dependencies.importRepository.removeMaterialCover(materialId);
    useLibraryStore.getState().updateMaterial(updated);
    useShellUiStore.getState().setStatusMessage('已移除自定义封面');
  });

  registry.register(COMMAND_IDS.libraryRestoreMetadata, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) {
      throw new Error('恢复来源元数据命令缺少材料 ID');
    }
    const updated = await dependencies.importRepository.restoreSourceMetadata(materialId);
    useLibraryStore.getState().updateMaterial(updated);
    useShellUiStore.getState().setStatusMessage('已恢复来源元数据');
  });

  registry.register(COMMAND_IDS.libraryTrash, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) {
      throw new Error('删除资料命令缺少材料 ID');
    }
    const trashed = await dependencies.importRepository.trashMaterial(materialId);
    useLibraryStore.getState().removeMaterial(materialId);
    useLibraryStore.getState().setTrashedMaterials([
      ...useLibraryStore.getState().trashedMaterials.filter((item) => item.id !== trashed.id),
      trashed,
    ]);
    useShellUiStore.getState().setStatusMessage(`已移入回收站:${trashed.title}`);
  });

  registry.register(COMMAND_IDS.libraryRestoreFromTrash, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) {
      throw new Error('恢复资料命令缺少材料 ID');
    }
    const restored = await dependencies.importRepository.restoreMaterial(materialId);
    useLibraryStore.getState().removeTrashedMaterial(materialId);
    useLibraryStore.getState().setMaterials([
      ...useLibraryStore.getState().materials.filter((item) => item.id !== restored.id),
      restored,
    ]);
    useShellUiStore.getState().setStatusMessage(`已恢复:${restored.title}`);
  });

  registry.register(COMMAND_IDS.libraryPurge, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) {
      throw new Error('永久删除资料命令缺少材料 ID');
    }
    await dependencies.importRepository.purgeMaterial(materialId);
    const viewIds = useWorkspaceStore
      .getState()
      .editorGroups.flatMap((group) =>
        group.views.filter((view) => view.materialId === materialId).map((view) => view.id),
      );
    for (const viewId of viewIds) {
      useReaderRuntime.getState().removeDocument(viewId);
    }
    useWorkspaceStore.getState().removeMaterial(materialId);
    useAnnotationStore.getState().removeMaterialAnnotations(materialId);
    useMarkdownSessionStore.getState().removeSession(materialId);
    if (dependencies.workspaceRepository) {
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
    }
    useLibraryStore.getState().removeTrashedMaterial(materialId);
    useShellUiStore.getState().setStatusMessage('已永久删除');
  });

  registry.register(COMMAND_IDS.libraryRelink, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) {
      throw new Error('重新关联命令缺少材料 ID');
    }
    const sourcePaths = await dependencies.filePicker.pickBooks();
    if (!sourcePaths || sourcePaths.length === 0) {
      return;
    }
    if (sourcePaths.length !== 1) {
      throw new Error('重新关联一次只能选择一份文件');
    }

    let staged: StagedImport | undefined;
    try {
      staged = await dependencies.importRepository.stageImport(sourcePaths[0]!);
      const relinked = await dependencies.importRepository.relinkMaterial(materialId, staged);
      const [materials, trashedMaterials] = await Promise.all([
        dependencies.importRepository.listMaterials(),
        dependencies.importRepository.listTrashed(),
      ]);
      useLibraryStore.getState().setMaterials(materials);
      useLibraryStore.getState().setTrashedMaterials(trashedMaterials);
      useShellUiStore.getState().setStatusMessage(`已重新关联:${relinked.title}`);
      await dependencies.reloadMaterialViews?.(materialId);
      dependencies.reloadApplication?.();
    } catch (error) {
      if (staged) {
        await dependencies.importRepository.discardImport(staged).catch(() => undefined);
      }
      throw error;
    }
  });

  registry.register(COMMAND_IDS.libraryImport, async () => {
    const unavailableMaterialIds = new Set(
      useLibraryStore
        .getState()
        .materials.filter((material) => material.managedFileAvailable === false)
        .map((material) => material.id),
    );
    useLibraryStore.getState().setImporting(true);
    try {
      const outcomes = await importBooks(dependencies);
      if (outcomes === null) {
        useShellUiStore.getState().setStatusMessage('已取消导入');
        return;
      }

      const materials = await dependencies.importRepository.listMaterials();
      useLibraryStore.getState().setMaterials(materials);

      if (
        outcomes.some(
          (outcome) =>
            outcome.kind === 'success' && unavailableMaterialIds.has(outcome.material.id),
        )
      ) {
        for (const outcome of outcomes) {
          if (outcome.kind === 'success' && unavailableMaterialIds.has(outcome.material.id)) {
            await dependencies.reloadMaterialViews?.(outcome.material.id);
          }
        }
        dependencies.reloadApplication?.();
      }

      const succeeded = outcomes.filter((outcome) => outcome.kind === 'success').length;
      const migrationCandidates = outcomes.flatMap((outcome) =>
        outcome.kind === 'migrationCandidate' ? outcome.candidates : [],
      );
      if (migrationCandidates.length > 0) {
        useShellUiStore.getState().setVersionMigrationCandidates(migrationCandidates);
      }
      const failed = outcomes.filter((outcome) => outcome.kind === 'failure');
      const coverWarnings = outcomes.flatMap((outcome) =>
        outcome.kind !== 'failure' && outcome.coverWarning
          ? [`${outcome.fileName}（${outcome.coverWarning}）`]
          : [],
      );
      const coverStatus = coverWarnings.length > 0
        ? `;封面降级 ${coverWarnings.length} 份:${coverWarnings.join('、')}`
        : '';
      if (failed.length === 0 && migrationCandidates.length === 0) {
        useShellUiStore
          .getState()
          .setStatusMessage(`已导入 ${succeeded} 份文件${coverStatus}`);
      } else {
        useShellUiStore
          .getState()
          .setStatusMessage(
            `导入完成:成功 ${succeeded} 份,待确认版本迁移 ${migrationCandidates.length} 份,失败 ${failed.length} 份${
              failed.length > 0
                ? `(${failed.map((outcome) => outcome.fileName).join('、')})`
                : ''
            }${coverStatus}`,
          );
      }
    } catch (error) {
      console.error('导入失败', error);
      useShellUiStore.getState().setStatusMessage('导入失败,请检查文件');
      throw error;
    } finally {
      useLibraryStore.getState().setImporting(false);
    }
  });

  registry.register(COMMAND_IDS.libraryPreviewVersionMigration, async (...args: unknown[]) => {
    const candidate = (args[0] as VersionMigrationCandidate | undefined) ??
      useShellUiStore.getState().versionMigrationCandidates[0];
    if (!candidate) throw new Error('没有可预览的版本迁移候选');
    if (!dependencies.annotationRepository || !dependencies.workspaceRepository) {
      throw new Error('版本迁移需要批注与工作区 Repository');
    }
    if (typeof document === 'undefined' || !document.body) {
      throw new Error('当前环境无法挂载 EPUB 预览文档');
    }

    const bytes = await dependencies.importRepository.readStagedFile(candidate.staged);
    const annotations = await dependencies.annotationRepository.listByMaterial(candidate.material.id);
    const deletedAnnotations = await dependencies.annotationRepository.listDeletedByMaterial(
      candidate.material.id,
    );
    // 位置节流器可能尚未把最新状态写回 Repository，预览必须以当前可序列化 Store 为准。
    const workspaceState = serializeWorkspaceState();
    const container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    container.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(container);
    const source = new File([
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ], candidate.staged.originalFileName, { type: 'application/epub+zip' });
    const documentModel = new EpubBookDocument({
      source,
      metadata: candidate.metadata,
      viewHostFactory: dependencies.viewHostFactory ?? createFoliateViewHostFactory(),
      sourceFingerprint: candidate.staged.fingerprint,
    });
    try {
      await documentModel.open(container);
      const preview = await buildVersionMigrationPreview({
        candidate,
        document: documentModel,
        annotations,
        deletedAnnotations,
        workspaceState,
      });
      useShellUiStore.getState().setVersionMigrationPreview(preview);
    } finally {
      documentModel.close();
      container.remove();
    }
  });

  registry.register(COMMAND_IDS.libraryCommitVersionMigration, async (...args: unknown[]) => {
    const preview = (args[0] as VersionMigrationPreview | undefined) ??
      useShellUiStore.getState().versionMigrationPreview;
    if (!preview) throw new Error('没有待确认的版本迁移预览');
    if (!dependencies.annotationRepository || !dependencies.workspaceRepository) {
      throw new Error('版本迁移需要批注与工作区 Repository');
    }
    const result = await dependencies.importRepository.commitVersionMigration({
      materialId: preview.candidate.material.id,
      staged: preview.candidate.staged,
      metadata: preview.candidate.metadata,
      sourceCover: preview.candidate.sourceCover ?? null,
      expectedSourceFingerprint: preview.candidate.material.fingerprint,
      expectedTargetFingerprint: preview.candidate.staged.fingerprint,
      annotations: preview.migratedAnnotations,
      workspaceState: preview.migratedWorkspaceState,
      previousAnnotations: preview.sourceAnnotations,
      previousWorkspaceState: preview.sourceWorkspaceState,
    });
    if (dependencies.syncVersionMigrationState !== false) {
      if (preview.migratedAnnotations.length > 0) {
        await dependencies.annotationRepository.saveAnnotations(preview.migratedAnnotations);
      }
      await dependencies.workspaceRepository.saveState(preview.migratedWorkspaceState);
    }
    useLibraryStore.getState().updateMaterial(result.material);
    useAnnotationStore
      .getState()
      .setMaterialAnnotations(
        result.material.id,
        preview.migratedAnnotations.filter((annotation) => annotation.deletedAt === null),
      );
    useWorkspaceStore.getState().hydrate(preview.migratedWorkspaceState);
    const remainingCandidates = useShellUiStore
      .getState()
      .versionMigrationCandidates.filter(
        (candidate) => candidate.staged.id !== preview.candidate.staged.id,
      );
    useShellUiStore.getState().setVersionMigrationCandidates(remainingCandidates);
    useShellUiStore.getState().setVersionMigrationPreview(null);
    useShellUiStore.getState().setStatusMessage('已完成版本迁移，迁移前快照已保留');
    dependencies.reloadApplication?.();
  });

  registry.register(COMMAND_IDS.libraryCancelVersionMigration, async () => {
    const candidates = useShellUiStore.getState().versionMigrationCandidates;
    const stagedIds = new Set(candidates.map((candidate) => candidate.staged.id));
    for (const candidate of candidates) {
      if (stagedIds.has(candidate.staged.id)) {
        await dependencies.importRepository.discardImport(candidate.staged).catch(() => undefined);
      }
      stagedIds.delete(candidate.staged.id);
    }
    useShellUiStore.getState().setVersionMigrationCandidates([]);
    useShellUiStore.getState().setVersionMigrationPreview(null);
  });

  registry.register(COMMAND_IDS.libraryListVersionMigrationSnapshots, async () => {
    const snapshots = await dependencies.importRepository.listVersionMigrationSnapshots();
    useShellUiStore.getState().setVersionMigrationSnapshots(snapshots);
    useShellUiStore.getState().openVersionMigrationSnapshots();
  });

  registry.register(COMMAND_IDS.libraryRestoreVersionMigrationSnapshot, async (...args: unknown[]) => {
    const snapshotId = args[0] as string | undefined;
    if (!snapshotId) throw new Error('恢复迁移快照命令缺少快照 ID');
    if (!dependencies.annotationRepository || !dependencies.workspaceRepository) {
      throw new Error('恢复迁移快照需要批注与工作区 Repository');
    }
    const result = await dependencies.importRepository.restoreVersionMigrationSnapshot(snapshotId);
    if (dependencies.syncVersionMigrationState !== false) {
      if (result.annotations.length > 0) {
        await dependencies.annotationRepository.saveAnnotations(result.annotations);
      }
      await dependencies.workspaceRepository.saveState(result.workspaceState);
    }
    useLibraryStore.getState().updateMaterial(result.material);
    useAnnotationStore
      .getState()
      .setMaterialAnnotations(
        result.material.id,
        result.annotations.filter((annotation) => annotation.deletedAt === null),
      );
    useWorkspaceStore.getState().hydrate(result.workspaceState);
    useShellUiStore.getState().setStatusMessage('已恢复迁移前版本，快照仍然保留');
    dependencies.reloadApplication?.();
  });

  registry.register(COMMAND_IDS.libraryClearVersionMigrationSnapshot, async (...args: unknown[]) => {
    const snapshotId = args[0] as string | undefined;
    if (!snapshotId) throw new Error('清除迁移快照命令缺少快照 ID');
    await dependencies.importRepository.clearVersionMigrationSnapshot(snapshotId);
    const snapshots = await dependencies.importRepository.listVersionMigrationSnapshots();
    useShellUiStore.getState().setVersionMigrationSnapshots(snapshots);
  });
}
