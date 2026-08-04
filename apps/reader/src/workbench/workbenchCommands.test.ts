import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_IDS, CommandRegistry } from '../commands/commandRegistry';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { registerWorkbenchCommands } from './workbenchCommands';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';

describe('工作台命令处理', () => {
  let repository: WorkspaceRepository;
  let registry: CommandRegistry;

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    registry = new CommandRegistry();
    registerWorkbenchCommands(registry, { workspaceRepository: repository });
    useWorkspaceStore.getState().resetToDefault();
    useShellUiStore.getState().clearStatusMessage();
  });

  it('切换主侧栏命令会更新 Store 并把新状态持久化', async () => {
    await registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar);

    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
    await expect(repository.loadState()).resolves.toEqual({
      schemaVersion: 1,
      primarySidebarVisible: false,
    });
  });

  it('连续两次切换回到原状态并保持持久化一致', async () => {
    await registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar);
    await registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar);

    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(true);
    await expect(repository.loadState()).resolves.toEqual({
      schemaVersion: 1,
      primarySidebarVisible: true,
    });
  });

  it('持久化成功后状态栏展示保存结果', async () => {
    await registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar);

    expect(useShellUiStore.getState().statusMessage).toContain('已保存工作区状态');
  });

  it('持久化失败时不改变 Store 并向外抛出错误', async () => {
    const failingRepository: WorkspaceRepository = {
      loadState: () => Promise.resolve({ schemaVersion: 1, primarySidebarVisible: true }),
      saveState: () => Promise.reject(new Error('disk error')),
    };
    const failingRegistry = new CommandRegistry();
    registerWorkbenchCommands(failingRegistry, { workspaceRepository: failingRepository });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      failingRegistry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar),
    ).rejects.toThrow('disk error');
    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(true);
    expect(useShellUiStore.getState().statusMessage).toContain('保存工作区状态失败');
    spy.mockRestore();
  });
});
