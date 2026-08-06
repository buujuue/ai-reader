import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { DEFAULT_WORKSPACE_STATE } from '../domain/workspace/workspaceState';
import type { FoliateViewHost } from '../domain/reader/viewHost';
import { createAppServices, type AppServices } from './bootstrap';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { useReaderRuntime } from '../workbench/readerRuntime';
import { App } from './App';
import { AppServicesProvider } from './AppServicesContext';

function renderApp(services: AppServices) {
  return render(
    <AppServicesProvider services={services}>
      <App />
    </AppServicesProvider>,
  );
}

function createFakeViewHost(): FoliateViewHost {
  return {
    async open() {},
    async init() {},
    async next() {},
    async prev() {},
    async goToLocation() {},
    getCurrentCFI() {
      return null;
    },
    onRelocate() {
      return () => undefined;
    },
    onContentData() {
      return () => undefined;
    },
    close() {},
  };
}

describe('阅读工作台外壳', () => {
  let repository: WorkspaceRepository;
  let services: AppServices;

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    services = createAppServices({ workspaceRepository: repository });
    useWorkspaceStore.getState().resetToDefault();
  });

  it('呈现简体中文工作台外壳', () => {
    renderApp(services);

    expect(screen.getByText('AI Reader')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '活动栏' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '书库侧栏' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '状态栏' })).toBeInTheDocument();
    expect(screen.getByText(/尚未导入阅读材料/)).toBeInTheDocument();
  });

  it('点击活动栏按钮通过 Command 往返隐藏主侧栏并持久化', async () => {
    const user = userEvent.setup();
    renderApp(services);

    const toggle = screen.getByRole('button', { name: '切换主侧栏' });
    await user.click(toggle);

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: '书库侧栏' })).not.toBeInTheDocument();
    });
    await expect(repository.loadState()).resolves.toEqual({
      ...DEFAULT_WORKSPACE_STATE,
      primarySidebarVisible: false,
    });
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(
      /已保存工作区状态/,
    );
  });

  it('再次点击按钮可以恢复主侧栏', async () => {
    const user = userEvent.setup();
    renderApp(services);

    const toggle = screen.getByRole('button', { name: '切换主侧栏' });
    await user.click(toggle);
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: '书库侧栏' })).not.toBeInTheDocument();
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(
        screen.getByRole('complementary', { name: '书库侧栏' }),
      ).toBeInTheDocument();
    });
  });

  it('启动时恢复此前持久化的侧栏隐藏状态', async () => {
    await repository.saveState({
      ...structuredClone(DEFAULT_WORKSPACE_STATE),
      primarySidebarVisible: false,
    });

    renderApp(services);
    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: '书库侧栏' }),
      ).not.toBeInTheDocument();
    });
    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
  });

  it('点击导入按钮后书库侧栏显示导入的阅读材料', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));

    await waitFor(() => {
      expect(screen.getByText('示例书')).toBeInTheDocument();
    });
    expect(screen.getByText('示例作者')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(/已导入:示例书/);
  });
});

describe('打开 EPUB 并重启续读', () => {
  let repository: WorkspaceRepository;
  let services: AppServices;

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    services = createAppServices({
      workspaceRepository: repository,
      viewHostFactory: () => createFakeViewHost(),
    });
    useWorkspaceStore.getState().resetToDefault();
  });

  it('从书库打开一本书后会新增阅读标签', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /示例书/ });

    await user.click(openButton);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /示例书/ })).toBeInTheDocument();
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });
  });

  it('重启后从持久化状态恢复阅读标签与位置', async () => {
    // 先模拟一次会话:打开一本书并记录一个阅读位置。
    const user = userEvent.setup();
    const firstRender = renderApp(services);
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /示例书/ });
    await user.click(openButton);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });

    const materialId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.materialId;
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    useWorkspaceStore.getState().setViewLocation(viewId, {
      kind: 'epub',
      cfi: 'epubcfi(/6/4)',
    });
    const workspace = useWorkspaceStore.getState();
    await repository.saveState({
      schemaVersion: 2,
      primarySidebarVisible: workspace.primarySidebarVisible,
      activeEditorGroupId: workspace.activeEditorGroupId,
      editorGroups: workspace.editorGroups,
    });

    // 模拟重启:卸载旧会话,重置 Store 与运行时,用同一 Repository 重新渲染。
    firstRender.unmount();
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
    renderApp(services);
    await waitFor(() => {
      const views = useWorkspaceStore.getState().editorGroups.flatMap((group) => group.views);
      expect(views).toHaveLength(1);
      expect(views[0]!.materialId).toBe(materialId);
      expect(views[0]!.location).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/4)' });
    });
  });
});