import { save } from '@tauri-apps/plugin-dialog';

/** 备份目标选择器窄接口。取消选择返回 null,不调用导出命令。 */
export interface BackupDestinationPicker {
  pickBackupDestination(): Promise<string | null>;
}

export function createTauriBackupDestinationPicker(): BackupDestinationPicker {
  return {
    async pickBackupDestination(): Promise<string | null> {
      return await save({
        defaultPath: 'ai-reader-backup.airbackup',
        filters: [{ name: 'AI Reader 书库备份', extensions: ['airbackup'] }],
      });
    },
  };
}

export function createInMemoryBackupDestinationPicker(): BackupDestinationPicker {
  return {
    async pickBackupDestination(): Promise<string | null> {
      return null;
    },
  };
}
