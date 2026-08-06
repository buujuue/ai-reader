import { create } from 'zustand';

import {
  DEFAULT_WORKSPACE_STATE,
  type EditorGroupState,
  type ReadingViewState,
  type WorkspaceState,
} from '../domain/workspace/workspaceState';

/**
 * Workspace Store 只持有可序列化的工作区状态;渲染器、选区等活对象属于 Reader Runtime,
 * 不进入本 Store。 actions 不参与持久化。
 */
export interface WorkspaceStoreState {
  primarySidebarVisible: boolean;
  activeEditorGroupId: string;
  editorGroups: EditorGroupState[];
  setPrimarySidebarVisible: (visible: boolean) => void;
  openView: (materialId: string) => string;
  closeView: (viewId: string) => void;
  setActiveView: (groupId: string, viewId: string) => void;
  setViewLocation: (viewId: string, location: WorkspaceState['editorGroups'][number]['views'][number]['location']) => void;
  hydrate: (state: WorkspaceState) => void;
  resetToDefault: () => void;
}

function nextViewId(): string {
  return crypto.randomUUID();
}

export const useWorkspaceStore = create<WorkspaceStoreState>()((set, get) => ({
  primarySidebarVisible: DEFAULT_WORKSPACE_STATE.primarySidebarVisible,
  activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
  editorGroups: structuredClone(DEFAULT_WORKSPACE_STATE.editorGroups),

  setPrimarySidebarVisible: (visible) => set({ primarySidebarVisible: visible }),

  openView: (materialId) => {
    const groupId = get().activeEditorGroupId;
    const view: ReadingViewState = {
      id: nextViewId(),
      materialId,
      location: null,
    };
    set((state) => ({
      editorGroups: state.editorGroups.map((group) =>
        group.id === groupId
          ? { ...group, views: [...group.views, view], activeViewId: view.id }
          : group,
      ),
    }));
    return view.id;
  },

  closeView: (viewId) => {
    set((state) => ({
      editorGroups: state.editorGroups.map((group) => {
        if (!group.views.some((view) => view.id === viewId)) {
          return group;
        }
        const views = group.views.filter((view) => view.id !== viewId);
        const activeViewId =
          group.activeViewId === viewId ? (views.at(-1)?.id ?? null) : group.activeViewId;
        return { ...group, views, activeViewId };
      }),
    }));
  },

  setActiveView: (groupId, viewId) => {
    set((state) => ({
      editorGroups: state.editorGroups.map((group) =>
        group.id === groupId ? { ...group, activeViewId: viewId } : group,
      ),
    }));
  },

  setViewLocation: (viewId, location) => {
    set((state) => ({
      editorGroups: state.editorGroups.map((group) => ({
        ...group,
        views: group.views.map((view) =>
          view.id === viewId ? { ...view, location } : view,
        ),
      })),
    }));
  },

  hydrate: (state) =>
    set({
      primarySidebarVisible: state.primarySidebarVisible,
      activeEditorGroupId: state.activeEditorGroupId,
      editorGroups: structuredClone(state.editorGroups),
    }),

  resetToDefault: () =>
    set({
      primarySidebarVisible: DEFAULT_WORKSPACE_STATE.primarySidebarVisible,
      activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
      editorGroups: structuredClone(DEFAULT_WORKSPACE_STATE.editorGroups),
    }),
}));