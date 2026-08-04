import { invoke } from '@tauri-apps/api/core';

import type { WorkspaceRepository } from './workspaceRepository';
import type { WorkspaceState } from './workspaceState';

export const WORKSPACE_COMMAND_NAMES = {
  loadState: 'load_workspace_state',
  saveState: 'save_workspace_state',
} as const;

/**
 * Tauri invoke 的窄接口。生产环境绑定 @tauri-apps/api 的 invoke，
 * 测试环境注入伪后端，从而在同一契约下验证命令名与参数边界。
 */
export type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

function assertWorkspaceStateShape(raw: unknown): WorkspaceState {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('workspace state payload is not an object');
  }
  const candidate = raw as Partial<WorkspaceState>;
  if (
    typeof candidate.schemaVersion !== 'number' ||
    typeof candidate.primarySidebarVisible !== 'boolean'
  ) {
    throw new Error('workspace state payload is malformed');
  }
  return {
    schemaVersion: candidate.schemaVersion,
    primarySidebarVisible: candidate.primarySidebarVisible,
  };
}

export function createTauriWorkspaceRepository(invoke: TauriInvoke): WorkspaceRepository {
  return {
    async loadState(): Promise<WorkspaceState> {
      const raw = await invoke(WORKSPACE_COMMAND_NAMES.loadState);
      return assertWorkspaceStateShape(raw);
    },
    async saveState(state: WorkspaceState): Promise<void> {
      await invoke(WORKSPACE_COMMAND_NAMES.saveState, { state });
    },
  };
}

export function createDefaultTauriWorkspaceRepository(): WorkspaceRepository {
  return createTauriWorkspaceRepository((command, args) => invoke(command, args));
}
