import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_IDS, CommandRegistry } from '../commands/commandRegistry';
import {
  createInMemoryWorkbenchAppearancePreferences,
  type WorkbenchAppearancePreferences,
} from '../app/workbenchAppearance';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { DEFAULT_WORKSPACE_STATE } from '../domain/workspace/workspaceState';
import { useShellUiStore } from './shellUiStore';
import { useWorkbenchAppearanceStore } from './appearanceStore';
import { registerWorkbenchCommands } from './workbenchCommands';

describe('工作台外观命令', () => {
  let preferences: WorkbenchAppearancePreferences;
  let registry: CommandRegistry;
  let repository: ReturnType<typeof createInMemoryWorkspaceRepository>;

  beforeEach(() => {
    preferences = createInMemoryWorkbenchAppearancePreferences();
    registry = new CommandRegistry();
    repository = createInMemoryWorkspaceRepository();
    registerWorkbenchCommands(registry, {
      workspaceRepository: repository,
      appearancePreferences: preferences,
    });
    useWorkbenchAppearanceStore.getState().resetToDefault();
    useShellUiStore.getState().clearStatusMessage();
  });

  it('通过稳定命令独立保存主题和背景光，并保持工作区状态不变', async () => {
    await registry.execute(COMMAND_IDS.workbenchSetAppearanceTheme, 'claude');
    await registry.execute(COMMAND_IDS.workbenchSetBackgroundGlow, false);

    expect(useWorkbenchAppearanceStore.getState()).toMatchObject({
      theme: 'claude',
      glowEnabled: false,
    });
    expect(preferences.load()).toEqual({ theme: 'claude', glowEnabled: false });
    await expect(repository.loadState()).resolves.toEqual(DEFAULT_WORKSPACE_STATE);
  });

  it('本机偏好保存失败时不改变当前外观并报告错误', async () => {
    const save = vi.fn(() => {
      throw new Error('storage unavailable');
    });
    const failingPreferences: WorkbenchAppearancePreferences = {
      load: () => ({ theme: 'midnight', glowEnabled: true }),
      save,
    };
    const failingRegistry = new CommandRegistry();
    registerWorkbenchCommands(failingRegistry, {
      workspaceRepository: repository,
      appearancePreferences: failingPreferences,
    });

    await expect(
      failingRegistry.execute(COMMAND_IDS.workbenchSetAppearanceTheme, 'mint'),
    ).rejects.toThrow('storage unavailable');
    expect(useWorkbenchAppearanceStore.getState()).toMatchObject({
      theme: 'midnight',
      glowEnabled: true,
    });
    expect(useShellUiStore.getState().statusMessage).toContain('保存工作台外观失败');
  });
});
