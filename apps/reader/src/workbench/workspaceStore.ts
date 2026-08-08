import { create } from 'zustand';

import {
  createNavigationHistory,
  pushExplicit,
  replaceCurrent,
  type NavigationHistory,
} from '../domain/reader/navigationHistory';
import type { ReadingLocation } from '../domain/reader/readingLocation';
import type { ReadingTypography } from '../domain/reader/typography';
import { resolveTypography } from '../domain/reader/typography';
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
  /** 全局阅读默认设置。 */
  globalReadingTypography: ReadingTypography;
  /** 阅读材料级排版覆盖;键为 BookId。 */
  materialTypography: Record<string, Partial<ReadingTypography>>;
  setPrimarySidebarVisible: (visible: boolean) => void;
  setGlobalReadingTypography: (settings: ReadingTypography) => void;
  setMaterialTypography: (materialId: string, override: Partial<ReadingTypography>) => void;
  resetMaterialTypography: (materialId: string) => void;
  getEffectiveTypography: (materialId: string) => ReadingTypography;
  openView: (materialId: string) => string;
  closeView: (viewId: string) => void;
  setActiveView: (groupId: string, viewId: string) => void;
  setViewLocation: (viewId: string, location: WorkspaceState['editorGroups'][number]['views'][number]['location']) => void;
  pushViewLocation: (viewId: string, location: ReadingLocation) => void;
  setViewHistory: (viewId: string, history: NavigationHistory) => void;
  hydrate: (state: WorkspaceState) => void;
  resetToDefault: () => void;
}

function nextViewId(): string {
  return crypto.randomUUID();
}

function updateView(
  state: Pick<WorkspaceStoreState, 'editorGroups'>,
  viewId: string,
  update: (view: ReadingViewState) => ReadingViewState,
): Pick<WorkspaceStoreState, 'editorGroups'> {
  return {
    editorGroups: state.editorGroups.map((group) => ({
      ...group,
      views: group.views.map((view) => (view.id === viewId ? update(view) : view)),
    })),
  };
}

export const useWorkspaceStore = create<WorkspaceStoreState>()((set, get) => ({
  primarySidebarVisible: DEFAULT_WORKSPACE_STATE.primarySidebarVisible,
  activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
  editorGroups: structuredClone(DEFAULT_WORKSPACE_STATE.editorGroups),
  globalReadingTypography: DEFAULT_WORKSPACE_STATE.globalReadingTypography,
  materialTypography: structuredClone(DEFAULT_WORKSPACE_STATE.materialTypography),

  setPrimarySidebarVisible: (visible) => set({ primarySidebarVisible: visible }),

  setGlobalReadingTypography: (settings) => set({ globalReadingTypography: settings }),

  setMaterialTypography: (materialId, override) =>
    set((state) => ({
      materialTypography: {
        ...state.materialTypography,
        [materialId]: { ...state.materialTypography[materialId], ...override },
      },
    })),

  resetMaterialTypography: (materialId) =>
    set((state) => {
      if (!(materialId in state.materialTypography)) {
        return state;
      }
      const next = { ...state.materialTypography };
      delete next[materialId];
      return { materialTypography: next };
    }),

  getEffectiveTypography: (materialId) => {
    const state = get();
    return resolveTypography(
      state.globalReadingTypography,
      state.materialTypography[materialId] ?? null,
    );
  },

  openView: (materialId) => {
    const groupId = get().activeEditorGroupId;
    const view: ReadingViewState = {
      id: nextViewId(),
      materialId,
      location: null,
      history: createNavigationHistory(),
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
    set((state) =>
      updateView(state, viewId, (view) => {
        const history = location
          ? replaceCurrent(view.history, location)
          : view.history;
        return { ...view, location, history };
      }),
    );
  },

  pushViewLocation: (viewId, location) => {
    set((state) =>
      updateView(state, viewId, (view) => ({
        ...view,
        location,
        history: pushExplicit(view.history, location),
      })),
    );
  },

  setViewHistory: (viewId, history) => {
    set((state) =>
      updateView(state, viewId, (view) => ({
        ...view,
        history,
        location: history.positions[history.index] ?? null,
      })),
    );
  },

  hydrate: (state) =>
    set({
      primarySidebarVisible: state.primarySidebarVisible,
      activeEditorGroupId: state.activeEditorGroupId,
      editorGroups: structuredClone(state.editorGroups),
      globalReadingTypography: state.globalReadingTypography,
      materialTypography: structuredClone(state.materialTypography),
    }),

  resetToDefault: () =>
    set({
      primarySidebarVisible: DEFAULT_WORKSPACE_STATE.primarySidebarVisible,
      activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
      editorGroups: structuredClone(DEFAULT_WORKSPACE_STATE.editorGroups),
      globalReadingTypography: DEFAULT_WORKSPACE_STATE.globalReadingTypography,
      materialTypography: structuredClone(DEFAULT_WORKSPACE_STATE.materialTypography),
    }),
}));