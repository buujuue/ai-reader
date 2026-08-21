import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_IDS, CommandRegistry } from '../commands/commandRegistry';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { DEFAULT_WORKSPACE_STATE } from '../domain/workspace/workspaceState';
import { registerWorkbenchCommands } from './workbenchCommands';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';

describe('工作台命令处理', () => {
  let repository: WorkspaceRepository;
  let registry: CommandRegistry;

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    registry = new CommandRegistry();
    registerWorkbenchCommands(registry, { workspaceRepository: repository });
    useWorkspaceStore.getState().resetToDefault();
    useShellUiStore.getState().clearStatusMessage();
  });

  it('切换主侧栏命令会更新 Store 并把新状态持久化', async () => {
    await registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar);

    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
    await expect(repository.loadState()).resolves.toEqual({
      ...DEFAULT_WORKSPACE_STATE,
      primarySidebarVisible: false,
    });
  });

  it('连续两次切换回到原状态并保持持久化一致', async () => {
    await registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar);
    await registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar);

    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(true);
    await expect(repository.loadState()).resolves.toEqual(DEFAULT_WORKSPACE_STATE);
  });

  it('持久化成功后状态栏展示保存结果', async () => {
    await registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar);

    expect(useShellUiStore.getState().statusMessage).toContain('已保存工作区状态');
  });

  it('持久化失败时不改变 Store 并向外抛出错误', async () => {
    const failingRepository: WorkspaceRepository = {
      loadState: () => Promise.resolve(DEFAULT_WORKSPACE_STATE),
      saveState: () => Promise.reject(new Error('disk error')),
    };
    const failingRegistry = new CommandRegistry();
    registerWorkbenchCommands(failingRegistry, { workspaceRepository: failingRepository });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      failingRegistry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar),
    ).rejects.toThrow('disk error');
    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(true);
    expect(useShellUiStore.getState().statusMessage).toContain('保存工作区状态失败');
    spy.mockRestore();
  });

  it('切换目录命令切换目录侧栏的运行时可见状态', async () => {
    expect(useWorkspaceStore.getState().tocVisible).toBe(false);

    await registry.execute(COMMAND_IDS.workbenchToggleToc);
    expect(useWorkspaceStore.getState().tocVisible).toBe(true);
    await expect(repository.loadState()).resolves.toMatchObject({ tocVisible: true });

    await registry.execute(COMMAND_IDS.workbenchToggleToc);
    expect(useWorkspaceStore.getState().tocVisible).toBe(false);
    await expect(repository.loadState()).resolves.toMatchObject({ tocVisible: false });
  });

  it('设置活动面板宽度命令会限制范围并持久化', async () => {
    await registry.execute(COMMAND_IDS.workbenchSetActivityPanelWidth, 999, true);

    expect(useWorkspaceStore.getState().activityPanelWidth).toBe(460);
    await expect(repository.loadState()).resolves.toMatchObject({ activityPanelWidth: 460 });

    await registry.execute(COMMAND_IDS.workbenchSetActivityPanelWidth, 120, true);
    expect(useWorkspaceStore.getState().activityPanelWidth).toBe(240);
  });

  it('返回键关闭对话框与 WebView 后退都经稳定命令执行', async () => {
    useShellUiStore.getState().openMetadataEditor('material-1');
    await registry.execute(COMMAND_IDS.shellDismissDialog, 'metadata');
    expect(useShellUiStore.getState().metadataEditorMaterialId).toBeNull();

    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await registry.execute(COMMAND_IDS.appBack, true);
    expect(historyBack).toHaveBeenCalledOnce();
    historyBack.mockRestore();
  });

  it('保存后重新加载会恢复标签、分组、活动视图和全部侧栏期望状态', async () => {
    const firstViewId = useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().openView('material-2');
    useWorkspaceStore.getState().splitEditorGroup('down');
    await registry.execute(COMMAND_IDS.workbenchToggleToc);
    useWorkspaceStore.getState().setPrimarySidebarVisible(false);

    await registry.execute(COMMAND_IDS.workbenchSaveState);

    useWorkspaceStore.getState().resetToDefault();
    const restored = await repository.loadState();
    useWorkspaceStore.getState().hydrate(restored);

    const state = useWorkspaceStore.getState();
    expect(state.primarySidebarVisible).toBe(false);
    expect(state.tocVisible).toBe(true);
    expect(state.editorGroups).toHaveLength(2);
    expect(state.editorGroups[0]!.views.map((view) => view.id)).toEqual([
      firstViewId,
      expect.any(String),
    ]);
    expect(state.activeEditorGroupId).toBe('group-2');
    expect(state.editorGroups[1]!.activeViewId).toBe(state.editorGroups[1]!.views[0]!.id);
  });

  it('关闭材料批注覆盖面板命令不写入工作区状态', async () => {
    useShellUiStore.getState().openAnnotationPanel('material-1');
    await registry.execute(COMMAND_IDS.shellDismissDialog, 'annotationPanel');

    expect(useShellUiStore.getState().annotationPanelMaterialId).toBeNull();
    await expect(repository.loadState()).resolves.toEqual(DEFAULT_WORKSPACE_STATE);
  });

  it('指定主要阅读材料命令不会依赖当前焦点并持久化材料身份', async () => {
    useWorkspaceStore.getState().openView('material-1');
    useWorkspaceStore.getState().openView('material-2');

    await registry.execute(COMMAND_IDS.workbenchSetPrimaryMaterial, 'material-2');
    useWorkspaceStore.getState().focusEditorGroup('group-1');

    expect(useWorkspaceStore.getState().primaryMaterialId).toBe('material-2');
    await expect(repository.loadState()).resolves.toEqual({
      ...DEFAULT_WORKSPACE_STATE,
      editorGroups: useWorkspaceStore.getState().editorGroups,
      primaryMaterialId: 'material-2',
    });
  });
});
