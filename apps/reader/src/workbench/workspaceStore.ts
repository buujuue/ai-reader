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
  SECOND_EDITOR_GROUP_ID,
  type EditorGroupSplitDirection,
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
  splitDirection: EditorGroupSplitDirection | null;
  activeEditorGroupId: string;
  editorGroups: EditorGroupState[];
  /** 全局阅读默认设置。 */
  globalReadingTypography: ReadingTypography;
  /** 阅读材料级排版覆盖;键为 BookId。 */
  materialTypography: Record<string, Partial<ReadingTypography>>;
  setPrimarySidebarVisible: (visible: boolean) => void;
  focusEditorGroup: (groupId: string) => void;
  splitEditorGroup: (
    direction: EditorGroupSplitDirection,
  ) => { groupId: string; viewId: string | null } | null;
  setGlobalReadingTypography: (settings: ReadingTypography) => void;
  setMaterialTypography: (materialId: string, override: Partial<ReadingTypography>) => void;
  resetMaterialTypography: (materialId: string) => void;
  getEffectiveTypography: (materialId: string) => ReadingTypography;
  openView: (materialId: string) => string;
  closeView: (viewId: string) => void;
  setActiveView: (groupId: string, viewId: string) => void;
  setViewSourceMode: (viewId: string, sourceMode: boolean) => void;
  setViewLocation: (viewId: string, location: WorkspaceState['editorGroups'][number]['views'][number]['location']) => void;
  pushViewLocation: (viewId: string, location: ReadingLocation) => void;
  setViewHistory: (viewId: string, history: NavigationHistory) => void;
  hydrate: (state: WorkspaceState) => void;
  resetToDefault: () => void;
}

function nextViewId(): string {
  return crypto.randomUUID();
}

function nextEditorGroupId(editorGroups: EditorGroupState[]): string {
  const usedIds = new Set(editorGroups.map((group) => group.id));
  let suffix = 2;
  let candidate = `group-${suffix}`;
  while (usedIds.has(candidate)) {
    suffix += 1;
    candidate = `group-${suffix}`;
  }
  return candidate;
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

interface NormalizedWorkspaceViews {
  splitDirection: EditorGroupSplitDirection | null;
  activeEditorGroupId: string;
  editorGroups: EditorGroupState[];
}

/** 恢复旧工作区时按材料身份去重,避免历史重复标签继续违反工作区不变量。 */
function normalizeWorkspaceViews(
  editorGroups: EditorGroupState[],
  activeEditorGroupId: string,
  splitDirection: EditorGroupSplitDirection | null,
): NormalizedWorkspaceViews {
  const sourceGroups = editorGroups.length > 0
    ? editorGroups
    : structuredClone(DEFAULT_WORKSPACE_STATE.editorGroups);
  const normalizedGroups = sourceGroups.slice(0, 2).map((group) => {
    const seenMaterialIds = new Set<string>();
    const views = group.views.filter((view) => {
      if (seenMaterialIds.has(view.materialId)) return false;
      seenMaterialIds.add(view.materialId);
      return true;
    });
    const activeViewId = views.some((view) => view.id === group.activeViewId)
      ? group.activeViewId
      : views.at(-1)?.id ?? null;
    return { ...group, views, activeViewId };
  });

  const activeGroup =
    normalizedGroups.find(
      (group) => group.id === activeEditorGroupId && group.views.length > 0,
    ) ??
    normalizedGroups.find((group) => group.views.length > 0) ??
    normalizedGroups.find((group) => group.id === activeEditorGroupId) ??
    normalizedGroups[0];

  return {
    splitDirection: normalizedGroups.length === 2 ? splitDirection : null,
    activeEditorGroupId: activeGroup?.id ?? normalizedGroups[0]?.id ?? activeEditorGroupId,
    editorGroups: normalizedGroups,
  };
}

export const useWorkspaceStore = create<WorkspaceStoreState>()((set, get) => ({
  primarySidebarVisible: DEFAULT_WORKSPACE_STATE.primarySidebarVisible,
  splitDirection: DEFAULT_WORKSPACE_STATE.splitDirection,
  activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
  editorGroups: structuredClone(DEFAULT_WORKSPACE_STATE.editorGroups),
  globalReadingTypography: DEFAULT_WORKSPACE_STATE.globalReadingTypography,
  materialTypography: structuredClone(DEFAULT_WORKSPACE_STATE.materialTypography),

  setPrimarySidebarVisible: (visible) => set({ primarySidebarVisible: visible }),

  focusEditorGroup: (groupId) =>
    set((state) =>
      state.editorGroups.some((group) => group.id === groupId)
        ? { activeEditorGroupId: groupId }
        : state,
    ),

  splitEditorGroup: (direction) => {
    const state = get();
    if (state.editorGroups.length >= 2) {
      return null;
    }

    const sourceGroup = state.editorGroups.find(
      (group) => group.id === state.activeEditorGroupId,
    );
    if (!sourceGroup) {
      return null;
    }

    const sourceView = sourceGroup.views.find((view) => view.id === sourceGroup.activeViewId);
    const copiedView = sourceView
      ? {
          ...structuredClone(sourceView),
          id: nextViewId(),
        }
      : null;
    const secondGroup: EditorGroupState = {
      id: state.editorGroups.some((group) => group.id === SECOND_EDITOR_GROUP_ID)
        ? nextEditorGroupId(state.editorGroups)
        : SECOND_EDITOR_GROUP_ID,
      views: copiedView ? [copiedView] : [],
      activeViewId: copiedView?.id ?? null,
    };

    set({
      splitDirection: direction,
      activeEditorGroupId: secondGroup.id,
      editorGroups: [...state.editorGroups, secondGroup],
    });
    return { groupId: secondGroup.id, viewId: copiedView?.id ?? null };
  },

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
    const state = get();
    const groupId = state.activeEditorGroupId;
    const activeGroup = state.editorGroups.find((group) => group.id === groupId);
    const existingView = activeGroup?.views.find((view) => view.materialId === materialId);
    if (existingView) {
      set({
        editorGroups: state.editorGroups.map((group) =>
          group.id === groupId ? { ...group, activeViewId: existingView.id } : group,
        ),
      });
      return existingView.id;
    }

    const view: ReadingViewState = {
      id: nextViewId(),
      materialId,
      location: null,
      history: createNavigationHistory(),
      sourceMode: false,
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
    set((state) => {
      const targetGroup = state.editorGroups.find((group) =>
        group.views.some((view) => view.id === viewId),
      );
      if (!targetGroup) {
        return state;
      }

      const nextGroups = state.editorGroups
        .map((group) => {
          if (group.id !== targetGroup.id) return group;
          const views = group.views.filter((view) => view.id !== viewId);
          const activeViewId =
            group.activeViewId === viewId ? (views.at(-1)?.id ?? null) : group.activeViewId;
          return { ...group, views, activeViewId };
        })
        .filter((group) => group.views.length > 0 || state.editorGroups.length === 1);
      const activeGroupId = nextGroups.some((group) => group.id === state.activeEditorGroupId)
        ? state.activeEditorGroupId
        : nextGroups[0]?.id ?? state.activeEditorGroupId;
      return {
        ...state,
        splitDirection: nextGroups.length === 2 ? state.splitDirection : null,
        activeEditorGroupId: activeGroupId,
        editorGroups: nextGroups,
      };
    });
  },

  /*
   * Keep the rest of the view actions group-agnostic: view ids are globally
   * unique, so location, history and Markdown mode remain independent across
   * split groups even when materialId is shared.
   */
  setActiveView: (groupId, viewId) => {
    set((state) => {
      const group = state.editorGroups.find((candidate) => candidate.id === groupId);
      if (!group || !group.views.some((view) => view.id === viewId)) {
        return state;
      }
      return {
        activeEditorGroupId: groupId,
        editorGroups: state.editorGroups.map((currentGroup) =>
          currentGroup.id === groupId ? { ...currentGroup, activeViewId: viewId } : currentGroup,
        ),
      };
    });
  },

  setViewSourceMode: (viewId, sourceMode) => {
    set((state) =>
      updateView(state, viewId, (view) => ({ ...view, sourceMode })),
    );
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

  hydrate: (state) => {
    const normalized = normalizeWorkspaceViews(
      state.editorGroups,
      state.activeEditorGroupId,
      state.splitDirection,
    );
    set({
      primarySidebarVisible: state.primarySidebarVisible,
      splitDirection: normalized.splitDirection,
      activeEditorGroupId: normalized.activeEditorGroupId,
      editorGroups: structuredClone(normalized.editorGroups),
      globalReadingTypography: state.globalReadingTypography,
      materialTypography: structuredClone(state.materialTypography),
    });
  },

  resetToDefault: () =>
    set({
      primarySidebarVisible: DEFAULT_WORKSPACE_STATE.primarySidebarVisible,
      splitDirection: DEFAULT_WORKSPACE_STATE.splitDirection,
      activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
      editorGroups: structuredClone(DEFAULT_WORKSPACE_STATE.editorGroups),
      globalReadingTypography: DEFAULT_WORKSPACE_STATE.globalReadingTypography,
      materialTypography: structuredClone(DEFAULT_WORKSPACE_STATE.materialTypography),
    }),
}));
