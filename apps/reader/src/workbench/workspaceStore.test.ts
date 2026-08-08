import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkspaceStore } from './workspaceStore';
import { DEFAULT_WORKSPACE_STATE } from '../domain/workspace/workspaceState';

describe('Workspace Store', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().resetToDefault();
  });

  it('初始可序列化状态等于默认工作区状态', () => {
    const state = useWorkspaceStore.getState();

    expect(state.primarySidebarVisible).toBe(DEFAULT_WORKSPACE_STATE.primarySidebarVisible);
    expect(state.editorGroups).toEqual(DEFAULT_WORKSPACE_STATE.editorGroups);
  });

  it('更新主侧栏期望可见状态', () => {
    useWorkspaceStore.getState().setPrimarySidebarVisible(false);

    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
  });

  it('用已持久化的工作区状态还原 Store', () => {
    useWorkspaceStore.getState().hydrate({
      ...DEFAULT_WORKSPACE_STATE,
      primarySidebarVisible: false,
    });

    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
  });

  it('打开一本书会在活动组新增标签并设为活动视图', () => {
    useWorkspaceStore.getState().openView('material-1');

    const group = useWorkspaceStore.getState().editorGroups[0]!;
    expect(group.views).toHaveLength(1);
    expect(group.views[0]!.materialId).toBe('material-1');
    expect(group.views[0]!.location).toBeNull();
    expect(group.activeViewId).toBe(group.views[0]!.id);
  });

  it('关闭活动标签后切换活动视图到相邻标签', () => {
    const first = useWorkspaceStore.getState().openView('material-1');
    const second = useWorkspaceStore.getState().openView('material-2');

    useWorkspaceStore.getState().closeView(first);

    const group = useWorkspaceStore.getState().editorGroups[0]!;
    expect(group.views).toHaveLength(1);
    expect(group.views[0]!.id).toBe(second);
    expect(useWorkspaceStore.getState().editorGroups[0]!.activeViewId).toBe(second);
  });

  it('记录某个阅读视图的可序列化位置', () => {
    const viewId = useWorkspaceStore.getState().openView('material-1');
    const location = { kind: 'epub' as const, cfi: 'epubcfi(/6/1)' };

    useWorkspaceStore.getState().setViewLocation(viewId, location);

    expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location).toEqual(location);
  });

  it('显式跳转把位置压入历史节点', () => {
    const viewId = useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/1)' });
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/2)' });

    const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
    expect(view.history.positions).toEqual([
      { kind: 'epub', cfi: 'epubcfi(/6/1)' },
      { kind: 'epub', cfi: 'epubcfi(/6/2)' },
    ]);
    expect(view.history.index).toBe(1);
    expect(view.location).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/2)' });
  });

  it('普通翻页只替换当前历史节点', () => {
    const viewId = useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/1)' });
    useWorkspaceStore.getState().setViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/1#a)' });

    const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
    expect(view.history.positions).toEqual([{ kind: 'epub', cfi: 'epubcfi(/6/1#a)' }]);
    expect(view.history.index).toBe(0);
  });

  it('设置历史后当前阅读位置跟随历史索引', () => {
    const viewId = useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().setViewHistory(viewId, {
      positions: [
        { kind: 'epub', cfi: 'epubcfi(/6/1)' },
        { kind: 'epub', cfi: 'epubcfi(/6/2)' },
      ],
      index: 0,
    });

    const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
    expect(view.location).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/1)' });
  });
});