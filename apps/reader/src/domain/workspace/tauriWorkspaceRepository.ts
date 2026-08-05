import { invoke } from '@tauri-apps/api/core';

import type { TauriInvoke } from '../tauriInvoke';
import type { WorkspaceRepository } from './workspaceRepository';
import type { WorkspaceState } from './workspaceState';

export const WORKSPACE_COMMAND_NAMES = {
  loadState: 'load_workspace_state',
  saveState: 'save_workspace_state',
} as const;

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
