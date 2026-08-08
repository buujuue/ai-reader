import { expect, it } from 'vitest';

import type { ReadingLocation } from '../reader/readingLocation';
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
    const location: ReadingLocation = { kind: 'epub', cfi: 'epubcfi(/6/4[chap])!/4/2/2/1:0' };
    const state: typeof DEFAULT_WORKSPACE_STATE = {
      schemaVersion: 3,
      primarySidebarVisible: false,
      activeEditorGroupId: 'group-1',
      editorGroups: [
        {
          id: 'group-1',
          views: [
            {
              id: 'view-1',
              materialId: 'mat-1',
              location,
              history: {
                positions: [{ kind: 'epub', cfi: 'epubcfi(/6/3)' }, location],
                index: 1,
              },
            },
          ],
          activeViewId: 'view-1',
        },
      ],
    };

    await repository.saveState(state);

    await expect(repository.loadState()).resolves.toEqual(state);
  });

  it('再次保存会覆盖先前的工作区状态', async () => {
    const repository = makeRepository();
    await repository.saveState({
      schemaVersion: 3,
      primarySidebarVisible: false,
      activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
      editorGroups: DEFAULT_WORKSPACE_STATE.editorGroups,
    });

    await repository.saveState({
      schemaVersion: 3,
      primarySidebarVisible: true,
      activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
      editorGroups: DEFAULT_WORKSPACE_STATE.editorGroups,
    });

    await expect(repository.loadState()).resolves.toEqual({
      schemaVersion: 3,
      primarySidebarVisible: true,
      activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
      editorGroups: DEFAULT_WORKSPACE_STATE.editorGroups,
    });
  });
}