import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from './libraryStore';
import { importBooks, type ImportBookDependencies } from './importBook';
import { useShellUiStore } from './shellUiStore';

/** 空串与 null 都归一为 null(清除覆盖并回落到来源),避免把空覆盖钉住。 */
function normalizeOverrideValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 书库相关的稳定 Command 唯一实现入口。TS 只经 typed ImportRepository 调用平台能力。 */
export function registerLibraryCommands(
  registry: CommandRegistry,
  dependencies: ImportBookDependencies,
): void {
  registry.register(COMMAND_IDS.libraryRefresh, async () => {
    const [materials, trashedMaterials] = await Promise.all([
      dependencies.importRepository.listMaterials(),
      dependencies.importRepository.listTrashed(),
    ]);
    useLibraryStore.getState().setMaterials(materials);
    useLibraryStore.getState().setTrashedMaterials(trashedMaterials);
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
    useLibraryStore.getState().removeTrashedMaterial(materialId);
    useShellUiStore.getState().setStatusMessage('已永久删除');
  });

  registry.register(COMMAND_IDS.libraryImport, async () => {
    useLibraryStore.getState().setImporting(true);
    try {
      const outcomes = await importBooks(dependencies);
      if (outcomes === null) {
        useShellUiStore.getState().setStatusMessage('已取消导入');
        return;
      }

      const materials = await dependencies.importRepository.listMaterials();
      useLibraryStore.getState().setMaterials(materials);

      const succeeded = outcomes.filter((outcome) => outcome.kind === 'success').length;
      const failed = outcomes.filter((outcome) => outcome.kind === 'failure');
      if (failed.length === 0) {
        useShellUiStore
          .getState()
          .setStatusMessage(`已导入 ${succeeded} 份文件`);
      } else {
        useShellUiStore
          .getState()
          .setStatusMessage(
            `导入完成:成功 ${succeeded} 份,失败 ${failed.length} 份(${failed
              .map((outcome) => outcome.fileName)
              .join('、')})`,
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
}