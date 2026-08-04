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
  });

  it('更新主侧栏期望可见状态', () => {
    useWorkspaceStore.getState().setPrimarySidebarVisible(false);

    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
  });

  it('用已持久化的工作区状态还原 Store', () => {
    useWorkspaceStore.getState().hydrate({ schemaVersion: 1, primarySidebarVisible: false });

    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
  });
});
