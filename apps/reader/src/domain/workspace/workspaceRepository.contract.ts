import { expect, it } from 'vitest';

import type { ReadingLocation } from '../reader/readingLocation';
import type { WorkspaceRepository } from './workspaceRepository';
import { DEFAULT_WORKSPACE_STATE, WORKSPACE_STATE_SCHEMA_VERSION } from './workspaceState';

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
      schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
      primarySidebarVisible: false,
      tocVisible: false,
      interfacePanelVisible: true,
      activityPanelWidth: 336,
      primaryMaterialId: 'mat-1',
      splitDirection: 'down',
      activeEditorGroupId: 'group-1',
      editorGroups: [
        {
          id: 'group-1',
          views: [
            {
              id: 'view-1',
              materialId: 'mat-1',
              location,
              sourceMode: true,
              history: {
                positions: [{ kind: 'epub', cfi: 'epubcfi(/6/3)' }, location],
                index: 1,
              },
            },
          ],
          activeViewId: 'view-1',
        },
      ],
      globalReadingTypography: DEFAULT_WORKSPACE_STATE.globalReadingTypography,
      materialTypography: {
        'mat-1': { fontSize: 22, flow: 'scrolled' },
      },
      expandedLibraryFolderIds: ['folder-1'],
      unfiledMaterialsExpanded: false,
    };

    await repository.saveState(state);

    await expect(repository.loadState()).resolves.toEqual(state);
  });

  it('再次保存会覆盖先前的工作区状态', async () => {
    const repository = makeRepository();
    await repository.saveState({
      schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
      primarySidebarVisible: false,
      tocVisible: false,
      interfacePanelVisible: false,
      activityPanelWidth: 280,
      primaryMaterialId: null,
      splitDirection: null,
      activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
      editorGroups: DEFAULT_WORKSPACE_STATE.editorGroups,
      globalReadingTypography: DEFAULT_WORKSPACE_STATE.globalReadingTypography,
      materialTypography: {},
      expandedLibraryFolderIds: [],
      unfiledMaterialsExpanded: true,
    });

    await repository.saveState({
      schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
      primarySidebarVisible: true,
      tocVisible: true,
      interfacePanelVisible: false,
      activityPanelWidth: 420,
      primaryMaterialId: 'mat-2',
      splitDirection: null,
      activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
      editorGroups: DEFAULT_WORKSPACE_STATE.editorGroups,
      globalReadingTypography: DEFAULT_WORKSPACE_STATE.globalReadingTypography,
      materialTypography: {},
      expandedLibraryFolderIds: [],
      unfiledMaterialsExpanded: true,
    });

    await expect(repository.loadState()).resolves.toEqual({
      schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
      primarySidebarVisible: false,
      tocVisible: true,
      interfacePanelVisible: false,
      activityPanelWidth: 420,
      primaryMaterialId: 'mat-2',
      splitDirection: null,
      activeEditorGroupId: DEFAULT_WORKSPACE_STATE.activeEditorGroupId,
      editorGroups: DEFAULT_WORKSPACE_STATE.editorGroups,
      globalReadingTypography: DEFAULT_WORKSPACE_STATE.globalReadingTypography,
      materialTypography: {},
      expandedLibraryFolderIds: [],
      unfiledMaterialsExpanded: true,
    });
  });
}
