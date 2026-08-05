import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { EpubInspectError } from '../domain/library/epub/epubInspector';
import { useLibraryStore } from './libraryStore';
import { importOneBook, type ImportBookDependencies } from './importBook';
import { useShellUiStore } from './shellUiStore';

/** 书库相关的稳定 Command 唯一实现入口。TS 只经 typed ImportRepository 调用平台能力。 */
export function registerLibraryCommands(
  registry: CommandRegistry,
  dependencies: ImportBookDependencies,
): void {
  registry.register(COMMAND_IDS.libraryRefresh, async () => {
    const materials = await dependencies.importRepository.listMaterials();
    useLibraryStore.getState().setMaterials(materials);
  });

  registry.register(COMMAND_IDS.libraryImportOne, async () => {
    useLibraryStore.getState().setImporting(true);
    try {
      const material = await importOneBook(dependencies);
      if (material) {
        const materials = await dependencies.importRepository.listMaterials();
        useLibraryStore.getState().setMaterials(materials);
        useShellUiStore.getState().setStatusMessage(`已导入:${material.title}`);
      } else {
        useShellUiStore.getState().setStatusMessage('已取消导入');
      }
    } catch (error) {
      const message =
        error instanceof EpubInspectError ? error.message : '导入失败,请检查文件';
      console.error('导入失败', error);
      useShellUiStore.getState().setStatusMessage(`导入失败:${message}`);
      throw error;
    } finally {
      useLibraryStore.getState().setImporting(false);
    }
  });
}
