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
    expect(state.tocVisible).toBe(DEFAULT_WORKSPACE_STATE.tocVisible);
    expect(state.primaryMaterialId).toBe(DEFAULT_WORKSPACE_STATE.primaryMaterialId);
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

  it('还原只有一份已打开材料的旧状态时自动指定主要阅读材料', () => {
    const viewId = crypto.randomUUID();
    useWorkspaceStore.getState().hydrate({
      ...DEFAULT_WORKSPACE_STATE,
      primaryMaterialId: null,
      editorGroups: [
        {
          id: 'group-1',
          views: [
            {
              id: viewId,
              materialId: 'material-1',
              location: null,
              history: { positions: [], index: -1 },
              sourceMode: false,
            },
          ],
          activeViewId: viewId,
        },
      ],
    });

    expect(useWorkspaceStore.getState().primaryMaterialId).toBe('material-1');
  });

  it('打开一本书会在活动组新增标签并设为活动视图', () => {
    useWorkspaceStore.getState().openView('material-1');

    const group = useWorkspaceStore.getState().editorGroups[0]!;
    expect(group.views).toHaveLength(1);
    expect(group.views[0]!.materialId).toBe('material-1');
    expect(group.views[0]!.location).toBeNull();
    expect(group.activeViewId).toBe(group.views[0]!.id);
    expect(useWorkspaceStore.getState().primaryMaterialId).toBe('material-1');
  });

  it('打开第二份材料或切换焦点不会偷偷改变主要阅读材料', () => {
    useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().openView('material-2');
    useWorkspaceStore.getState().focusEditorGroup('group-1');

    expect(useWorkspaceStore.getState().primaryMaterialId).toBe('material-1');
  });

  it('用户可以显式指定主要阅读材料', () => {
    useWorkspaceStore.getState().setPrimaryMaterial('material-2');

    expect(useWorkspaceStore.getState().primaryMaterialId).toBe('material-2');
  });

  it('关闭材料后只剩一份材料时自动将它设为主要阅读材料', () => {
    const firstViewId = useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().openView('material-2');
    useWorkspaceStore.getState().closeView(firstViewId);

    expect(useWorkspaceStore.getState().primaryMaterialId).toBe('material-2');
  });

  it('重复打开同一本书会复用原标签并激活它', () => {
    const first = useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().openView('material-2');

    const reopened = useWorkspaceStore.getState().openView('material-1');

    const group = useWorkspaceStore.getState().editorGroups[0]!;
    expect(reopened).toBe(first);
    expect(group.views).toHaveLength(2);
    expect(group.activeViewId).toBe(first);
  });

  it('向右拆分当前阅读任务并复制视图状态到第二组', () => {
    const viewId = useWorkspaceStore.getState().openView('material-1');
    const location = { kind: 'epub' as const, cfi: 'epubcfi(/6/4)' };
    useWorkspaceStore.getState().setViewLocation(viewId, location);
    useWorkspaceStore.getState().setViewSourceMode(viewId, true);

    const result = useWorkspaceStore.getState().splitEditorGroup('right');
    const state = useWorkspaceStore.getState();
    const secondGroup = state.editorGroups[1]!;
    const copiedView = secondGroup.views[0]!;

    expect(result).toEqual({ groupId: 'group-2', viewId: copiedView.id });
    expect(state.splitDirection).toBe('right');
    expect(state.activeEditorGroupId).toBe('group-2');
    expect(copiedView.id).not.toBe(viewId);
    expect(copiedView.materialId).toBe('material-1');
    expect(copiedView.location).toEqual(location);
    expect(copiedView.sourceMode).toBe(true);
    expect(state.editorGroups[0]!.views[0]!.id).toBe(viewId);
  });

  it('同一本书可以在两个编辑器组拥有独立阅读视图', () => {
    const firstViewId = crypto.randomUUID();
    const duplicateViewId = crypto.randomUUID();
    useWorkspaceStore.getState().hydrate({
      ...DEFAULT_WORKSPACE_STATE,
      splitDirection: 'down',
      activeEditorGroupId: 'group-2',
      editorGroups: [
        {
          id: 'group-1',
          views: [
            {
              id: firstViewId,
              materialId: 'material-1',
              location: null,
              history: { positions: [], index: -1 },
              sourceMode: false,
            },
          ],
          activeViewId: firstViewId,
        },
        {
          id: 'group-2',
          views: [
            {
              id: duplicateViewId,
              materialId: 'material-1',
              location: null,
              history: { positions: [], index: -1 },
              sourceMode: false,
            },
          ],
          activeViewId: duplicateViewId,
        },
      ],
    });

    const state = useWorkspaceStore.getState();

    expect(state.activeEditorGroupId).toBe('group-2');
    expect(state.splitDirection).toBe('down');
    expect(state.editorGroups.flatMap((group) => group.views)).toHaveLength(2);
    expect(state.editorGroups[0]!.views[0]!.id).toBe(firstViewId);
    expect(state.editorGroups[1]!.views[0]!.id).toBe(duplicateViewId);
  });

  it('活动组已有同一本书时复用标签,但另一组可以再打开同一本书', () => {
    const firstViewId = useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().splitEditorGroup('right');

    const secondViewId = useWorkspaceStore.getState().openView('material-1');
    const reopenedInSecondGroup = useWorkspaceStore.getState().openView('material-1');
    const state = useWorkspaceStore.getState();

    expect(secondViewId).not.toBe(firstViewId);
    expect(reopenedInSecondGroup).toBe(secondViewId);
    expect(state.editorGroups[0]!.views).toHaveLength(1);
    expect(state.editorGroups[1]!.views).toHaveLength(1);
  });

  it('第二次拆分不会递归增加编辑器组', () => {
    useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().splitEditorGroup('right');

    const result = useWorkspaceStore.getState().splitEditorGroup('down');
    const state = useWorkspaceStore.getState();

    expect(result).toBeNull();
    expect(state.editorGroups).toHaveLength(2);
    expect(state.splitDirection).toBe('right');
  });

  it('关闭第二组最后一个标签时收起拆分并保留第一组', () => {
    useWorkspaceStore.getState().openView('material-1');
    const result = useWorkspaceStore.getState().splitEditorGroup('right');
    useWorkspaceStore.getState().closeView(result!.viewId!);

    const state = useWorkspaceStore.getState();
    expect(state.editorGroups).toHaveLength(1);
    expect(state.splitDirection).toBeNull();
    expect(state.activeEditorGroupId).toBe('group-1');
  });

  it('删除原始组后再次拆分仍保持编辑器组 id 唯一', () => {
    const firstViewId = useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().splitEditorGroup('right');
    useWorkspaceStore.getState().focusEditorGroup('group-1');
    useWorkspaceStore.getState().closeView(firstViewId);

    const result = useWorkspaceStore.getState().splitEditorGroup('down');
    const state = useWorkspaceStore.getState();

    expect(result?.groupId).toBe('group-3');
    expect(new Set(state.editorGroups.map((group) => group.id)).size).toBe(2);
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
