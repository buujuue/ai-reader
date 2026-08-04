import type { WorkspaceState } from './workspaceState';

export interface WorkspaceRepository {
  loadState(): Promise<WorkspaceState>;
  saveState(state: WorkspaceState): Promise<void>;
}
