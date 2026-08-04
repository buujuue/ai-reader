import { expect, it } from 'vitest';

import type { WorkspaceRepository } from './workspaceRepository';
import { DEFAULT_WORKSPACE_STATE } from './workspaceState';

export type WorkspaceRepositoryFactory = () => WorkspaceRepository;

export function workspaceRepositoryContract(makeRepository: WorkspaceRepositoryFactory): void {
  it('加载尚未保存过的工作区状态时返回默认状态', async () => {
    const repository = makeRepository();

    await expect(repository.loadState()).resolves.toEqual(DEFAULT_WORKSPACE_STATE);
  });

  it('保存后能够加载同一份工作区状态', async () => {
    const repository = makeRepository();
    const state = { schemaVersion: 1, primarySidebarVisible: false };

    await repository.saveState(state);

    await expect(repository.loadState()).resolves.toEqual(state);
  });

  it('再次保存会覆盖先前的工作区状态', async () => {
    const repository = makeRepository();
    await repository.saveState({ schemaVersion: 1, primarySidebarVisible: false });

    await repository.saveState({ schemaVersion: 1, primarySidebarVisible: true });

    await expect(repository.loadState()).resolves.toEqual({
      schemaVersion: 1,
      primarySidebarVisible: true,
    });
  });
}
