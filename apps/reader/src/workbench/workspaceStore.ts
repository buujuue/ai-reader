import { create } from 'zustand';

import { DEFAULT_WORKSPACE_STATE, type WorkspaceState } from '../domain/workspace/workspaceState';

/**
 * Workspace Store 只持有可序列化的工作区状态;渲染器、选区等活对象属于 Reader Runtime,
 * 不进入本 Store。 actions 不参与持久化。
 */
export interface WorkspaceStoreState {
  primarySidebarVisible: boolean;
  setPrimarySidebarVisible: (visible: boolean) => void;
  hydrate: (state: WorkspaceState) => void;
  resetToDefault: () => void;
}

export const useWorkspaceStore = create<WorkspaceStoreState>()((set) => ({
  primarySidebarVisible: DEFAULT_WORKSPACE_STATE.primarySidebarVisible,
  setPrimarySidebarVisible: (visible) => set({ primarySidebarVisible: visible }),
  hydrate: (state) => set({ primarySidebarVisible: state.primarySidebarVisible }),
  resetToDefault: () =>
    set({ primarySidebarVisible: DEFAULT_WORKSPACE_STATE.primarySidebarVisible }),
}));
