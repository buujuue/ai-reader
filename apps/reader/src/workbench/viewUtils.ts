import type { ReadingViewState } from '../domain/workspace/workspaceState';
import { useWorkspaceStore } from './workspaceStore';

/** 在全部 Editor Group 中按 id 查找一个阅读视图;未找到时返回 undefined。 */
export function findView(viewId: string): ReadingViewState | undefined {
  const state = useWorkspaceStore.getState();
  for (const group of state.editorGroups) {
    const view = group.views.find((view) => view.id === viewId);
    if (view) return view;
  }
  return undefined;
}

/** 读取当前活动 Editor Group 的活动视图 id;无活动视图时返回 null。 */
export function getActiveViewId(): string | null {
  const state = useWorkspaceStore.getState();
  const group = state.editorGroups.find((group) => group.id === state.activeEditorGroupId);
  return group?.activeViewId ?? null;
}

/** 读取某视图归属的阅读材料 BookId;视图不存在时返回 null。 */
export function findViewMaterialId(viewId: string): string | null {
  return findView(viewId)?.materialId ?? null;
}

/** 在全部 Editor Group 中按材料 BookId 查找阅读视图;未找到时返回 undefined。 */
export function findViewByMaterialId(materialId: string): ReadingViewState | undefined {
  const state = useWorkspaceStore.getState();
  for (const group of state.editorGroups) {
    const view = group.views.find((view) => view.materialId === materialId);
    if (view) return view;
  }
  return undefined;
}
