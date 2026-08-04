import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { WORKSPACE_STATE_SCHEMA_VERSION } from '../domain/workspace/workspaceState';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';

export interface WorkbenchCommandDependencies {
  workspaceRepository: WorkspaceRepository;
}

/**
 * 工作台 Command 的唯一实现入口。持久化成功后才更新 Store,
 * 保证工作区状态以 Rust 侧提交的事实为准。
 */
export function registerWorkbenchCommands(
  registry: CommandRegistry,
  dependencies: WorkbenchCommandDependencies,
): void {
  registry.register(COMMAND_IDS.workbenchTogglePrimarySidebar, async () => {
    const nextVisible = !useWorkspaceStore.getState().primarySidebarVisible;

    try {
      await dependencies.workspaceRepository.saveState({
        schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
        primarySidebarVisible: nextVisible,
      });
    } catch (error) {
      console.error('保存工作区状态失败', error);
      useShellUiStore.getState().setStatusMessage('保存工作区状态失败');
      throw error;
    }

    useWorkspaceStore.getState().setPrimarySidebarVisible(nextVisible);
    useShellUiStore
      .getState()
      .setStatusMessage(nextVisible ? '已保存工作区状态:侧栏显示' : '已保存工作区状态:侧栏隐藏');
  });
}
