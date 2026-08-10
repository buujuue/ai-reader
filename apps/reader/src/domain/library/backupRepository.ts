export interface BackupExportResult {
  destinationPath: string;
  entryCount: number;
  totalBytes: number;
}

export interface BackupRestoreResult {
  materialCount: number;
  entryCount: number;
  totalBytes: number;
}

/** 完整书库导出 typed Repository。前端不接触数据库、归档格式或托管文件。 */
export interface BackupRepository {
  exportBackup(destinationPath: string): Promise<BackupExportResult>;
  restoreBackup(sourcePath: string): Promise<BackupRestoreResult>;
}

/** 浏览器降级模式没有 Rust 文件系统能力，保留明确失败边界。 */
export function createUnsupportedBackupRepository(): BackupRepository {
  return {
    async exportBackup(): Promise<BackupExportResult> {
      throw new Error('浏览器降级模式不支持导出完整书库备份');
    },
    async restoreBackup(): Promise<BackupRestoreResult> {
      throw new Error('浏览器降级模式不支持恢复完整书库备份');
    },
  };
}
