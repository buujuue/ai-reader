import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { createAppServices, type AppServices } from './bootstrap';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { App } from './App';
import { AppServicesProvider } from './AppServicesContext';

function renderApp(services: AppServices) {
  return render(
    <AppServicesProvider services={services}>
      <App />
    </AppServicesProvider>,
  );
}

describe('阅读工作台外壳', () => {
  let repository: WorkspaceRepository;
  let services: AppServices;

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    services = createAppServices(repository);
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
      schemaVersion: 1,
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
    await repository.saveState({ schemaVersion: 1, primarySidebarVisible: false });

    renderApp(services);
    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: '书库侧栏' }),
      ).not.toBeInTheDocument();
    });
    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
  });
});
