import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import {
  WORKSPACE_STATE_SCHEMA_VERSION,
  type WorkspaceState,
} from '../domain/workspace/workspaceState';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';

export interface WorkbenchCommandDependencies {
  workspaceRepository: WorkspaceRepository;
}

/** 从当前 Serialized Store 组装可持久化的工作区状态。 */
export function serializeWorkspaceState(): WorkspaceState {
  const store = useWorkspaceStore.getState();
  return {
    schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
    primarySidebarVisible: store.primarySidebarVisible,
    activeEditorGroupId: store.activeEditorGroupId,
    editorGroups: store.editorGroups,
  };
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
      const state = serializeWorkspaceState();
      await dependencies.workspaceRepository.saveState({
        ...state,
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

  registry.register(COMMAND_IDS.workbenchSaveState, async () => {
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });
}