import { invoke } from '@tauri-apps/api/core';

import type { TauriInvoke } from '../tauriInvoke';
import type { BackupExportResult, BackupRepository } from './backupRepository';

export const BACKUP_COMMAND_NAMES = {
  export: 'export_library_backup',
} as const;

function assertBackupResult(raw: unknown): BackupExportResult {
  const candidate = raw as Partial<BackupExportResult> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.destinationPath !== 'string' ||
    typeof candidate.entryCount !== 'number' ||
    typeof candidate.totalBytes !== 'number'
  ) {
    throw new Error('backup export payload is malformed');
  }
  return {
    destinationPath: candidate.destinationPath,
    entryCount: candidate.entryCount,
    totalBytes: candidate.totalBytes,
  };
}

export function createTauriBackupRepository(invokeFn: TauriInvoke): BackupRepository {
  return {
    async exportBackup(destinationPath: string): Promise<BackupExportResult> {
      const raw = await invokeFn(BACKUP_COMMAND_NAMES.export, { destinationPath });
      return assertBackupResult(raw);
    },
  };
}

export function createDefaultTauriBackupRepository(): BackupRepository {
  return createTauriBackupRepository((command, args) => invoke(command, args));
}
