import { create } from 'zustand';

import type { SearchMatch } from '../domain/reader/search';

/**
 * 当前材料搜索的运行时状态(不可持久化的活状态),按阅读视图 id 组织。
 * 搜索任务、命中高亮等活对象不进入 Workspace Store;这里只保存搜索过程的
 * 可渲染状态(查询、进度、结果、当前命中),供搜索栏与命令读取/更新。
 */

export type SearchStatus = 'idle' | 'searching' | 'completed' | 'cancelled' | 'error';

export interface SearchViewState {
  /** 搜索栏是否打开。 */
  active: boolean;
  query: string;
  matchCase: boolean;
  /** 全材料搜索进度 0..1。 */
  progress: number;
  status: SearchStatus;
  error: string | null;
  /** 已产出的命中(按产生顺序)。 */
  matches: SearchMatch[];
  /** 当前选中的命中在 `matches` 中的下标;-1 表示无。 */
  currentIndex: number;
  /** 当前命中对应的 CFI(供正文标记)。 */
  currentCfi: string | null;
}

export interface SearchStoreState {
  views: Record<string, SearchViewState>;
  getView: (viewId: string) => SearchViewState;
  open: (viewId: string) => void;
  close: (viewId: string) => void;
  begin: (viewId: string, query: string, matchCase: boolean) => void;
  setProgress: (viewId: string, progress: number) => void;
  addMatch: (viewId: string, match: SearchMatch) => void;
  complete: (viewId: string) => void;
  cancel: (viewId: string) => void;
  setError: (viewId: string, error: string) => void;
  setMatchCase: (viewId: string, matchCase: boolean) => void;
  setCurrentIndex: (viewId: string, index: number) => void;
  reset: (viewId: string) => void;
}

function emptyView(): SearchViewState {
  return {
    active: false,
    query: '',
    matchCase: false,
    progress: 0,
    status: 'idle',
    error: null,
    matches: [],
    currentIndex: -1,
    currentCfi: null,
  };
}

export const useSearchStore = create<SearchStoreState>()((set, get) => ({
  views: {},

  getView: (viewId) => get().views[viewId] ?? emptyView(),

  open: (viewId) =>
    set((state) => ({
      views: { ...state.views, [viewId]: { ...(state.views[viewId] ?? emptyView()), active: true } },
    })),

  close: (viewId) =>
    set((state) => {
      const views = { ...state.views };
      delete views[viewId];
      return { views };
    }),

  begin: (viewId, query, matchCase) =>
    set((state) => ({
      views: {
        ...state.views,
        [viewId]: {
          ...(state.views[viewId] ?? emptyView()),
          active: true,
          query,
          matchCase,
          progress: 0,
          status: 'searching',
          error: null,
          matches: [],
          currentIndex: -1,
          currentCfi: null,
        },
      },
    })),

  setProgress: (viewId, progress) =>
    set((state) => {
      const view = state.views[viewId];
      if (!view || view.status !== 'searching') return {};
      return { views: { ...state.views, [viewId]: { ...view, progress } } };
    }),

  addMatch: (viewId, match) =>
    set((state) => {
      const view = state.views[viewId];
      if (!view || view.status !== 'searching') return {};
      return {
        views: { ...state.views, [viewId]: { ...view, matches: [...view.matches, match] } },
      };
    }),

  complete: (viewId) =>
    set((state) => {
      const view = state.views[viewId];
      if (!view) return {};
      return { views: { ...state.views, [viewId]: { ...view, status: 'completed', progress: 1 } } };
    }),

  cancel: (viewId) =>
    set((state) => {
      if (!state.views[viewId]) return {};
      return {
        views: {
          ...state.views,
          [viewId]: { ...state.views[viewId]!, status: 'cancelled' },
        },
      };
    }),

  setError: (viewId, error) =>
    set((state) => {
      if (!state.views[viewId]) return {};
      return {
        views: {
          ...state.views,
          [viewId]: { ...state.views[viewId]!, status: 'error', error, progress: 1 },
        },
      };
    }),

  setMatchCase: (viewId, matchCase) =>
    set((state) => {
      if (!state.views[viewId]) return {};
      return { views: { ...state.views, [viewId]: { ...state.views[viewId]!, matchCase } } };
    }),

  setCurrentIndex: (viewId, index) =>
    set((state) => {
      const view = state.views[viewId];
      if (!view) return {};
      const next = view.matches[index];
      return {
        views: {
          ...state.views,
          [viewId]: { ...view, currentIndex: index, currentCfi: next?.cfi ?? null },
        },
      };
    }),

  reset: (viewId) =>
    set((state) => {
      const view = state.views[viewId];
      if (!view) return {};
      return {
        views: {
          ...state.views,
          [viewId]: {
            ...view,
            query: '',
            progress: 0,
            status: 'idle',
            error: null,
            matches: [],
            currentIndex: -1,
            currentCfi: null,
          },
        },
      };
    }),
}));