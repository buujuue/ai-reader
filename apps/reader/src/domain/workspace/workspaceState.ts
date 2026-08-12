import type { ReadingLocation } from '../reader/readingLocation';
import type { NavigationHistory } from '../reader/navigationHistory';
import type { ReadingTypography } from '../reader/typography';
import { DEFAULT_READING_TYPOGRAPHY } from '../reader/typography';

export const WORKSPACE_STATE_SCHEMA_VERSION = 8;

/** 第二个 Editor Group 的拆分方向。`right` 表示左右并排,`down` 表示上下并排。 */
export type EditorGroupSplitDirection = 'right' | 'down';

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
  /** 本视图的显示模式:true 表示 Markdown 源码模式,false 表示阅读模式。 */
  sourceMode: boolean;
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
  /** 目录侧栏的用户期望状态；紧凑布局只改变呈现方式，不改变此值。 */
  tocVisible: boolean;
  /** 批注侧栏的用户期望状态;窄布局只改变呈现,不改写此值。 */
  annotationSidebarVisible: boolean;
  /** 用户显式指定的主要阅读材料;与当前焦点阅读视图独立。 */
  primaryMaterialId: string | null;
  splitDirection: EditorGroupSplitDirection | null;
  activeEditorGroupId: string;
  editorGroups: EditorGroupState[];
  /** 全局阅读默认设置(所有材料共享的排版基线)。 */
  globalReadingTypography: ReadingTypography;
  /** 阅读材料级排版覆盖;键为 BookId,未出现的材料使用全局默认。 */
  materialTypography: Record<string, Partial<ReadingTypography>>;
}

export const DEFAULT_EDITOR_GROUP_ID = 'group-1';
export const SECOND_EDITOR_GROUP_ID = 'group-2';

export const DEFAULT_WORKSPACE_STATE: WorkspaceState = Object.freeze({
  schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
  primarySidebarVisible: true,
  tocVisible: false,
  annotationSidebarVisible: true,
  primaryMaterialId: null,
  splitDirection: null,
  activeEditorGroupId: DEFAULT_EDITOR_GROUP_ID,
  editorGroups: [
    Object.freeze({
      id: DEFAULT_EDITOR_GROUP_ID,
      views: [],
      activeViewId: null,
    }),
  ],
  globalReadingTypography: DEFAULT_READING_TYPOGRAPHY,
  materialTypography: Object.freeze({}),
});
