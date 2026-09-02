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
      return structuredClone({
        ...source,
        ...normalizeSidebarVisibility(
          source.primarySidebarVisible,
          source.tocVisible,
          source.interfacePanelVisible,
        ),
      });
    },
    async saveState(state: WorkspaceState): Promise<void> {
      stored = structuredClone({
        ...state,
        ...normalizeSidebarVisibility(
          state.primarySidebarVisible,
          state.tocVisible,
          state.interfacePanelVisible,
        ),
        unfiledMaterialsExpanded: state.unfiledMaterialsExpanded ?? true,
      });
    },
  };
}
