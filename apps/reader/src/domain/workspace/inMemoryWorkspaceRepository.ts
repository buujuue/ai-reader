import type { WorkspaceRepository } from './workspaceRepository';
import {
  DEFAULT_WORKSPACE_STATE,
  normalizeSidebarVisibility,
  type WorkspaceState,
} from './workspaceState';

export function createInMemoryWorkspaceRepository(): WorkspaceRepository {
  let stored: WorkspaceState | null = null;

  return {
    async loadState(): Promise<WorkspaceState> {
      const source = stored ?? DEFAULT_WORKSPACE_STATE;
      return structuredClone(source);
    },
    async saveState(state: WorkspaceState): Promise<void> {
      stored = structuredClone({
        ...state,
        ...normalizeSidebarVisibility(state.primarySidebarVisible, state.tocVisible),
        unfiledMaterialsExpanded: state.unfiledMaterialsExpanded ?? true,
      });
    },
  };
}
