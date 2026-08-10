import type { BackupDestinationPicker } from '../app/backupDestinationPicker';
import type { BackupSourcePicker } from '../app/backupSourcePicker';
import type { BackupRepository } from '../domain/library/backupRepository';
import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useShellUiStore } from './shellUiStore';

export interface BackupCommandDependencies {
  backupRepository: BackupRepository;
  destinationPicker: BackupDestinationPicker;
  sourcePicker: BackupSourcePicker;
  confirmUnencryptedBackup?: () => boolean;
  confirmRestore?: () => boolean;
  flushReaderPositions?: () => Promise<void>;
  reloadApplication?: (() => void) | undefined;
}

const UNENCRYPTED_BACKUP_WARNING =
  '书库备份未加密，包含全部书籍、阅读位置、工作区和私人批注。请确认你会妥善保管备份文件。';

const REPLACE_LIBRARY_WARNING =
  '恢复会整库替换当前书库，当前书库会先创建安全快照。请确认备份来源可信，并继续恢复。';

function defaultConfirm(): boolean {
  return typeof window === 'undefined' ? true : window.confirm(UNENCRYPTED_BACKUP_WARNING);
}

function defaultRestoreConfirm(): boolean {
  return typeof window === 'undefined' ? true : window.confirm(REPLACE_LIBRARY_WARNING);
}

/** 书库备份 Command 唯一实现入口:确认风险、选择目标、调用 typed Repository。 */
export function registerBackupCommands(
  registry: CommandRegistry,
  dependencies: BackupCommandDependencies,
): void {
  registry.register(COMMAND_IDS.libraryExportBackup, async () => {
    const confirmed = (dependencies.confirmUnencryptedBackup ?? defaultConfirm)();
    if (!confirmed) {
      useShellUiStore.getState().setStatusMessage('已取消书库备份');
      return null;
    }

    try {
      const destinationPath = await dependencies.destinationPicker.pickBackupDestination();
      if (!destinationPath) {
        useShellUiStore.getState().setStatusMessage('已取消书库备份');
        return null;
      }

      await dependencies.flushReaderPositions?.();
      const result = await dependencies.backupRepository.exportBackup(destinationPath);
      useShellUiStore
        .getState()
        .setStatusMessage(`书库备份已导出，共 ${result.entryCount} 个条目`);
      return result;
    } catch (error) {
      console.error('导出书库备份失败', error);
      useShellUiStore.getState().setStatusMessage('书库备份失败，未生成可用备份');
      throw error;
    }
  });

  registry.register(COMMAND_IDS.libraryRestoreBackup, async () => {
    const sourcePath = await dependencies.sourcePicker.pickBackupSource();
    if (!sourcePath) {
      useShellUiStore.getState().setStatusMessage('已取消书库恢复');
      return null;
    }
    if (!(dependencies.confirmRestore ?? defaultRestoreConfirm)()) {
      useShellUiStore.getState().setStatusMessage('已取消书库恢复');
      return null;
    }

    try {
      await dependencies.flushReaderPositions?.();
      const result = await dependencies.backupRepository.restoreBackup(sourcePath);
      useShellUiStore
        .getState()
        .setStatusMessage(`书库恢复成功，共恢复 ${result.materialCount} 本书`);
      dependencies.reloadApplication?.();
      return result;
    } catch (error) {
      console.error('恢复书库备份失败', error);
      useShellUiStore.getState().setStatusMessage('书库恢复失败，当前书库保持不变');
      throw error;
    }
  });
}
