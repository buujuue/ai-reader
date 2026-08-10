import { describe, expect, it } from 'vitest';

import { backupRepositoryContract } from './backupRepository.contract';
import { BACKUP_COMMAND_NAMES, createTauriBackupRepository } from './tauriBackupRepository';

backupRepositoryContract(() =>
  createTauriBackupRepository(async () => ({
    destinationPath: 'library.airbackup',
    entryCount: 4,
    totalBytes: 1024,
  })),
);

describe('Tauri backup repository', () => {
  it('调用稳定命令并校验导出结果', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const repository = createTauriBackupRepository(async (command, args) => {
      const call: { command: string; args?: Record<string, unknown> } = { command };
      if (args) call.args = args;
      calls.push(call);
      return {
        destinationPath: 'backup.airbackup',
        entryCount: 4,
        totalBytes: 1024,
      };
    });

    await expect(repository.exportBackup('backup.airbackup')).resolves.toEqual({
      destinationPath: 'backup.airbackup',
      entryCount: 4,
      totalBytes: 1024,
    });
    expect(calls).toEqual([
      {
        command: BACKUP_COMMAND_NAMES.export,
        args: { destinationPath: 'backup.airbackup' },
      },
    ]);
  });

  it('拒绝格式错误的导出结果', async () => {
    const repository = createTauriBackupRepository(async () => ({ entryCount: 4 }));

    await expect(repository.exportBackup('backup.airbackup')).rejects.toThrow(
      'backup export payload is malformed',
    );
  });
});
