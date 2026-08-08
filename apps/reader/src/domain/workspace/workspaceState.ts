import type { ReadingLocation } from '../reader/readingLocation';
import type { NavigationHistory } from '../reader/navigationHistory';

export const WORKSPACE_STATE_SCHEMA_VERSION = 3;

/** 一个编辑器组内的一次阅读视图(标签)的可序列化描述。 */
export interface ReadingViewState {
  /** 本视图的稳定标识(UUID)。 */
  id: string;
  /** 归属的阅读材料 BookId。 */
  materialId: string;
  /** 可恢复的阅读位置;尚未产生时为空。 */
  location: ReadingLocation | null;
  /** 本视图的导航历史(可序列化,最多 50 个节点)。 */
  history: NavigationHistory;
}

/** 一个编辑器组的可序列化状态。第一版最多两个组。 */
export interface EditorGroupState {
  id: string;
  views: ReadingViewState[];
  activeViewId: string | null;
}

/** 可持久化的工作区状态。活对象(渲染器、选区、加载任务)绝不进入本结构。 */
export interface WorkspaceState {
  schemaVersion: number;
  primarySidebarVisible: boolean;
  activeEditorGroupId: string;
  editorGroups: EditorGroupState[];
}

export const DEFAULT_EDITOR_GROUP_ID = 'group-1';

export const DEFAULT_WORKSPACE_STATE: WorkspaceState = Object.freeze({
  schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
  primarySidebarVisible: true,
  activeEditorGroupId: DEFAULT_EDITOR_GROUP_ID,
  editorGroups: [
    Object.freeze({
      id: DEFAULT_EDITOR_GROUP_ID,
      views: [],
      activeViewId: null,
    }),
  ],
});