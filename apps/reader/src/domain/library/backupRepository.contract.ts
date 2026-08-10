import { expect, it } from 'vitest';

import type { BackupRepository } from './backupRepository';

export type BackupRepositoryFactory = () => BackupRepository;

/** 内存与 Tauri 备份 Adapter 共享的最小行为契约。 */
export function backupRepositoryContract(makeRepository: BackupRepositoryFactory): void {
  it('导出目标路径并返回归档统计', async () => {
    const repository = makeRepository();

    await expect(repository.exportBackup('library.airbackup')).resolves.toEqual({
      destinationPath: 'library.airbackup',
      entryCount: 4,
      totalBytes: 1024,
    });
    await expect(repository.restoreBackup('library.airbackup')).resolves.toEqual({
      materialCount: 1,
      entryCount: 4,
      totalBytes: 1024,
    });
  });
}
