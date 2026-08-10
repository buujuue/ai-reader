import type { BackupExportResult, BackupRepository } from './backupRepository';

export interface InMemoryBackupRepositoryOptions {
  entryCount?: number;
  totalBytes?: number;
}

/** 仅供浏览器降级测试复用的内存备份 Adapter；不会写入真实文件。 */
export function createInMemoryBackupRepository(
  options: InMemoryBackupRepositoryOptions = {},
): BackupRepository {
  const entryCount = options.entryCount ?? 4;
  const totalBytes = options.totalBytes ?? 1024;
  return {
    async exportBackup(destinationPath: string): Promise<BackupExportResult> {
      return { destinationPath, entryCount, totalBytes };
    },
  };
}
