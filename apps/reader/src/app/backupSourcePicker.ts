import { open } from '@tauri-apps/plugin-dialog';

/** 完整书库备份来源选择器。取消选择返回 null。 */
export interface BackupSourcePicker {
  pickBackupSource(): Promise<string | null>;
}

export function createTauriBackupSourcePicker(): BackupSourcePicker {
  return {
    async pickBackupSource(): Promise<string | null> {
      return await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'AI Reader 书库备份', extensions: ['airbackup'] }],
      });
    },
  };
}

export function createInMemoryBackupSourcePicker(): BackupSourcePicker {
  return {
    async pickBackupSource(): Promise<string | null> {
      return null;
    },
  };
}
