import type { WorkspaceRepository } from './workspaceRepository';
import { DEFAULT_WORKSPACE_STATE, type WorkspaceState } from './workspaceState';

export function createInMemoryWorkspaceRepository(): WorkspaceRepository {
  let stored: WorkspaceState | null = null;

  return {
    async loadState(): Promise<WorkspaceState> {
      const source = stored ?? DEFAULT_WORKSPACE_STATE;
      return { ...source };
    },
    async saveState(state: WorkspaceState): Promise<void> {
      stored = { ...state };
    },
  };
}
