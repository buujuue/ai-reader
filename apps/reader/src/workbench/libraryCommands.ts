import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from './libraryStore';
import { importBooks, type ImportBookDependencies } from './importBook';
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