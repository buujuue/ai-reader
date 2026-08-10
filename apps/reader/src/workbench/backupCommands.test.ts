import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandRegistry } from '../commands/commandRegistry';
import type { BackupDestinationPicker } from '../app/backupDestinationPicker';
import type { BackupRepository } from '../domain/library/backupRepository';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useShellUiStore } from './shellUiStore';
import { registerBackupCommands } from './backupCommands';

function createHarness(options: {
  confirmed?: boolean;
  destination?: string | null;
  destinationError?: Error;
  exportResult?: { destinationPath: string; entryCount: number; totalBytes: number };
  exportError?: Error;
}) {
  const backupRepository: BackupRepository = {
    exportBackup: vi.fn(async () => {
      if (options.exportError) throw options.exportError;
      return options.exportResult ?? {
        destinationPath: options.destination ?? 'backup.airbackup',
        entryCount: 3,
        totalBytes: 100,
      };
    }),
  };
  const destinationPicker: BackupDestinationPicker = {
    pickBackupDestination: vi.fn(async () => {
      if (options.destinationError) throw options.destinationError;
      return options.destination ?? null;
    }),
  };
  const confirmUnencryptedBackup = vi.fn(() => options.confirmed ?? true);
  const flushReaderPositions = vi.fn(async () => undefined);
  const registry = new CommandRegistry();
  registerBackupCommands(registry, {
    backupRepository,
    destinationPicker,
    confirmUnencryptedBackup,
    flushReaderPositions,
  });
  return { registry, backupRepository, destinationPicker, confirmUnencryptedBackup, flushReaderPositions };
}

describe('library.exportBackup command', () => {
  beforeEach(() => {
    useShellUiStore.getState().clearStatusMessage();
  });

  it('用户拒绝未加密警告时不打开保存对话框也不调用导出', async () => {
    const harness = createHarness({ confirmed: false, destination: 'backup.airbackup' });

    const result = await harness.registry.execute(COMMAND_IDS.libraryExportBackup);

    expect(result).toBeNull();
    expect(harness.destinationPicker.pickBackupDestination).not.toHaveBeenCalled();
    expect(harness.backupRepository.exportBackup).not.toHaveBeenCalled();
    expect(useShellUiStore.getState().statusMessage).toBe('已取消书库备份');
  });

  it('用户取消目标选择时不调用导出且不报告成功', async () => {
    const harness = createHarness({ destination: null });

    const result = await harness.registry.execute(COMMAND_IDS.libraryExportBackup);

    expect(result).toBeNull();
    expect(harness.backupRepository.exportBackup).not.toHaveBeenCalled();
    expect(useShellUiStore.getState().statusMessage).toBe('已取消书库备份');
  });

  it('目标选择器失败时报告失败并不调用导出', async () => {
    const error = new Error('保存对话框失败');
    const harness = createHarness({ destinationError: error });

    await expect(
      harness.registry.execute(COMMAND_IDS.libraryExportBackup),
    ).rejects.toBe(error);

    expect(harness.flushReaderPositions).not.toHaveBeenCalled();
    expect(harness.backupRepository.exportBackup).not.toHaveBeenCalled();
    expect(useShellUiStore.getState().statusMessage).toBe('书库备份失败，未生成可用备份');
  });

  it('确认并选择目标后导出成功才报告完成', async () => {
    const harness = createHarness({ destination: 'backup.airbackup' });

    const result = await harness.registry.execute(COMMAND_IDS.libraryExportBackup);

    expect(harness.flushReaderPositions).toHaveBeenCalledOnce();
    expect(harness.backupRepository.exportBackup).toHaveBeenCalledWith('backup.airbackup');
    expect(result).toMatchObject({ entryCount: 3 });
    expect(useShellUiStore.getState().statusMessage).toBe('书库备份已导出，共 3 个条目');
  });

  it('导出失败时报告失败并向调用方传播错误', async () => {
    const error = new Error('空间不足');
    const harness = createHarness({ destination: 'backup.airbackup', exportError: error });

    await expect(
      harness.registry.execute(COMMAND_IDS.libraryExportBackup),
    ).rejects.toBe(error);

    expect(useShellUiStore.getState().statusMessage).toBe('书库备份失败，未生成可用备份');
  });
});
