import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import {
  applyWorkbenchAppearanceToDocument,
  createInMemoryWorkbenchAppearancePreferences,
  getWorkbenchTheme,
  isWorkbenchThemeId,
  type WorkbenchAppearance,
  type WorkbenchAppearancePreferences,
} from '../app/workbenchAppearance';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import {
  clampActivityPanelWidth,
  normalizeSidebarVisibility,
  WORKSPACE_STATE_SCHEMA_VERSION,
  type WorkspaceState,
} from '../domain/workspace/workspaceState';
import { useShellUiStore } from './shellUiStore';
import { useAnnotationStore } from './annotationStore';
import { useWorkbenchAppearanceStore } from './appearanceStore';
import { useWorkspaceStore } from './workspaceStore';

export interface WorkbenchCommandDependencies {
  workspaceRepository: WorkspaceRepository;
  annotationRepository?: AnnotationRepository;
  appearancePreferences?: WorkbenchAppearancePreferences;
}

type DismissibleShellDialog =
  | 'markdownDirtyClose'
  | 'metadata'
  | 'purge'
  | 'folderDelete'
  | 'externalLink'
  | 'note'
  | 'annotationPanel'
  | 'versionMigration'
  | 'versionMigrationSnapshots';

/** 从当前 Serialized Store 组装可持久化的工作区状态。 */
export function serializeWorkspaceState(): WorkspaceState {
  const store = useWorkspaceStore.getState();
  return {
    schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
    primarySidebarVisible: store.primarySidebarVisible,
    tocVisible: store.tocVisible,
    interfacePanelVisible: store.interfacePanelVisible,
    activityPanelWidth: store.activityPanelWidth,
    primaryMaterialId: store.primaryMaterialId,
    splitDirection: store.splitDirection,
    activeEditorGroupId: store.activeEditorGroupId,
    editorGroups: store.editorGroups,
    globalReadingTypography: store.globalReadingTypography,
    materialTypography: store.materialTypography,
    expandedLibraryFolderIds: store.expandedLibraryFolderIds,
    unfiledMaterialsExpanded: store.unfiledMaterialsExpanded,
  };
}

type ActivityPanelId = 'primary' | 'toc' | 'interface';

function withActivityPanelVisibility(
  state: WorkspaceState,
  panel: ActivityPanelId,
  visible: boolean,
): WorkspaceState {
  if (visible) {
    return {
      ...state,
      ...normalizeSidebarVisibility(
        panel === 'primary',
        panel === 'toc',
        panel === 'interface',
      ),
    };
  }
  return {
    ...state,
    ...normalizeSidebarVisibility(
      panel === 'primary' ? visible : state.primarySidebarVisible,
      panel === 'toc' ? visible : state.tocVisible,
      panel === 'interface' ? visible : state.interfacePanelVisible,
    ),
  };
}

function saveWorkbenchAppearance(
  preferences: WorkbenchAppearancePreferences,
  appearance: WorkbenchAppearance,
): void {
  try {
    preferences.save(appearance);
  } catch (error) {
    console.error('保存工作台外观失败', error);
    useShellUiStore.getState().setStatusMessage('保存工作台外观失败');
    throw error;
  }
}

/**
 * 工作台 Command 的唯一实现入口。持久化成功后才更新 Store,
 * 保证工作区状态以 Rust 侧提交的事实为准。
 */
export function registerWorkbenchCommands(
  registry: CommandRegistry,
  dependencies: WorkbenchCommandDependencies,
): void {
  const appearancePreferences =
    dependencies.appearancePreferences ?? createInMemoryWorkbenchAppearancePreferences();

  registry.register(COMMAND_IDS.appBack, async (...args: unknown[]) => {
    if (args[0] === true) window.history.back();
  });

  registry.register(COMMAND_IDS.shellDismissDialog, async (...args: unknown[]) => {
    const dialog = args[0] as DismissibleShellDialog | undefined;
    switch (dialog) {
      case 'markdownDirtyClose':
        useShellUiStore.getState().closeMarkdownDirtyClose();
        break;
      case 'metadata':
        useShellUiStore.getState().closeMetadataEditor();
        break;
      case 'purge':
        useShellUiStore.getState().closePurgeConfirm();
        break;
      case 'folderDelete':
        useShellUiStore.getState().closeFolderDeleteConfirm();
        break;
      case 'externalLink':
        useShellUiStore.getState().closeExternalLinkConfirm();
        break;
      case 'note':
        useShellUiStore.getState().closeNoteEditor();
        break;
      case 'annotationPanel':
        useShellUiStore.getState().closeAnnotationPanel();
        break;
      case 'versionMigration':
        void registry.execute(COMMAND_IDS.libraryCancelVersionMigration).catch(console.error);
        break;
      case 'versionMigrationSnapshots':
        useShellUiStore.getState().closeVersionMigrationSnapshots();
        break;
    }
  });

  registry.register(COMMAND_IDS.workbenchTogglePrimarySidebar, async () => {
    const workspace = useWorkspaceStore.getState();
    const shell = useShellUiStore.getState();
    if (workspace.primarySidebarVisible && shell.compactActivityPanelDismissed) {
      shell.restoreCompactActivityPanel();
      return;
    }
    const nextVisible = !workspace.primarySidebarVisible;

    try {
      await dependencies.workspaceRepository.saveState(
        withActivityPanelVisibility(serializeWorkspaceState(), 'primary', nextVisible),
      );
    } catch (error) {
      console.error('保存工作区状态失败', error);
      useShellUiStore.getState().setStatusMessage('保存工作区状态失败');
      throw error;
    }

    useWorkspaceStore.getState().setPrimarySidebarVisible(nextVisible);
    if (nextVisible) useShellUiStore.getState().restoreCompactActivityPanel();
    useShellUiStore
      .getState()
      .setStatusMessage(nextVisible ? '已保存工作区状态:侧栏显示' : '已保存工作区状态:侧栏隐藏');
  });

  registry.register(COMMAND_IDS.workbenchFocusLibraryFilter, async () => {
    if (!useWorkspaceStore.getState().primarySidebarVisible) {
      await dependencies.workspaceRepository.saveState(
        withActivityPanelVisibility(serializeWorkspaceState(), 'primary', true),
      );
      useWorkspaceStore.getState().setPrimarySidebarVisible(true);
    }
    useShellUiStore.getState().restoreCompactActivityPanel();
    useShellUiStore.getState().requestLibraryFilterFocus();
  });

  registry.register(COMMAND_IDS.workbenchSetPrimaryMaterial, async (...args: unknown[]) => {
    const materialId = args[0] as string | null | undefined;
    if (materialId !== null && (typeof materialId !== 'string' || materialId.length === 0)) return;
    if (materialId && dependencies.annotationRepository) {
      const annotations = await dependencies.annotationRepository.listByMaterial(materialId);
      useAnnotationStore.getState().setMaterialAnnotations(materialId, annotations);
    }
    const state = serializeWorkspaceState();
    await dependencies.workspaceRepository.saveState({ ...state, primaryMaterialId: materialId });
    useWorkspaceStore.getState().setPrimaryMaterial(materialId);
    useShellUiStore.getState().setStatusMessage('已指定主要阅读材料');
  });

  registry.register(COMMAND_IDS.workbenchToggleToc, async () => {
    const workspace = useWorkspaceStore.getState();
    const shell = useShellUiStore.getState();
    if (workspace.tocVisible && shell.compactActivityPanelDismissed) {
      shell.restoreCompactActivityPanel();
      return;
    }
    const nextVisible = !workspace.tocVisible;

    try {
      await dependencies.workspaceRepository.saveState(
        withActivityPanelVisibility(serializeWorkspaceState(), 'toc', nextVisible),
      );
    } catch (error) {
      console.error('保存目录侧栏状态失败', error);
      useShellUiStore.getState().setStatusMessage('保存目录侧栏状态失败');
      throw error;
    }

    useWorkspaceStore.getState().setTocVisible(nextVisible);
    if (nextVisible) useShellUiStore.getState().restoreCompactActivityPanel();
  });

  registry.register(COMMAND_IDS.workbenchToggleInterfacePanel, async () => {
    const workspace = useWorkspaceStore.getState();
    const shell = useShellUiStore.getState();
    if (workspace.interfacePanelVisible && shell.compactActivityPanelDismissed) {
      shell.restoreCompactActivityPanel();
      return;
    }
    const nextVisible = !workspace.interfacePanelVisible;

    try {
      await dependencies.workspaceRepository.saveState(
        withActivityPanelVisibility(serializeWorkspaceState(), 'interface', nextVisible),
      );
    } catch (error) {
      console.error('保存界面面板状态失败', error);
      useShellUiStore.getState().setStatusMessage('保存界面面板状态失败');
      throw error;
    }

    useWorkspaceStore.getState().setInterfacePanelVisible(nextVisible);
    if (nextVisible) useShellUiStore.getState().restoreCompactActivityPanel();
    useShellUiStore
      .getState()
      .setStatusMessage(nextVisible ? '已保存工作区状态:界面面板显示' : '已保存工作区状态:界面面板隐藏');
  });

  registry.register(COMMAND_IDS.workbenchSetAppearanceTheme, async (...args: unknown[]) => {
    const theme = args[0];
    if (!isWorkbenchThemeId(theme)) return;
    const current = useWorkbenchAppearanceStore.getState();
    const next = { theme, glowEnabled: current.glowEnabled };
    saveWorkbenchAppearance(appearancePreferences, next);
    useWorkbenchAppearanceStore.getState().setTheme(theme);
    applyWorkbenchAppearanceToDocument(next);
    useShellUiStore.getState().setStatusMessage(`已切换到${getWorkbenchTheme(theme).label}主题`);
  });

  registry.register(COMMAND_IDS.workbenchSetBackgroundGlow, async (...args: unknown[]) => {
    const glowEnabled = args[0];
    if (typeof glowEnabled !== 'boolean') return;
    const current = useWorkbenchAppearanceStore.getState();
    const next = { theme: current.theme, glowEnabled };
    saveWorkbenchAppearance(appearancePreferences, next);
    useWorkbenchAppearanceStore.getState().setGlowEnabled(glowEnabled);
    applyWorkbenchAppearanceToDocument(next);
    useShellUiStore.getState().setStatusMessage(glowEnabled ? '已开启背景光效果' : '已关闭背景光效果');
  });

  registry.register(COMMAND_IDS.workbenchSetActivityPanelWidth, async (...args: unknown[]) => {
    const width = args[0];
    if (typeof width !== 'number' || !Number.isFinite(width)) return;
    const nextWidth = clampActivityPanelWidth(width);
    const shouldPersist = args[1] === true;

    if (shouldPersist) {
      await dependencies.workspaceRepository.saveState({
        ...serializeWorkspaceState(),
        activityPanelWidth: nextWidth,
      });
    }
    useWorkspaceStore.getState().setActivityPanelWidth(nextWidth);
  });

  registry.register(COMMAND_IDS.workbenchSetLibraryFolderExpanded, async (...args: unknown[]) => {
    const folderId = args[0];
    const expanded = args[1];
    if (typeof folderId !== 'string' || folderId.length === 0 || typeof expanded !== 'boolean') return;
    const current = serializeWorkspaceState();
    const folderIds = new Set(current.expandedLibraryFolderIds ?? []);
    if (expanded) folderIds.add(folderId);
    else folderIds.delete(folderId);
    await dependencies.workspaceRepository.saveState({
      ...current,
      expandedLibraryFolderIds: [...folderIds],
    });
    useWorkspaceStore.getState().setLibraryFolderExpanded(folderId, expanded);
  });

  registry.register(COMMAND_IDS.workbenchSetUnfiledMaterialsExpanded, async (...args: unknown[]) => {
    const expanded = args[0];
    if (typeof expanded !== 'boolean') return;
    const current = serializeWorkspaceState();
    await dependencies.workspaceRepository.saveState({
      ...current,
      unfiledMaterialsExpanded: expanded,
    });
    useWorkspaceStore.getState().setUnfiledMaterialsExpanded(expanded);
  });

  registry.register(COMMAND_IDS.workbenchOpenAnnotationPanel, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) return;
    const returnFocusTarget =
      typeof HTMLElement !== 'undefined' && args[1] instanceof HTMLElement
        ? args[1]
        : null;
    useShellUiStore.getState().openAnnotationPanel(materialId, returnFocusTarget);
  });

  registry.register(COMMAND_IDS.annotationOpenNoteEditor, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    const annotationId = args[1] as string | undefined;
    if (!materialId || !annotationId) return;
    useShellUiStore.getState().openNoteEditor(materialId, annotationId);
  });

  registry.register(COMMAND_IDS.readerOpenTypography, async () => {
    const state = useWorkspaceStore.getState();
    if (state.interfacePanelVisible) {
      useShellUiStore.getState().restoreCompactActivityPanel();
      return;
    }
    try {
      await dependencies.workspaceRepository.saveState(
        withActivityPanelVisibility(serializeWorkspaceState(), 'interface', true),
      );
    } catch (error) {
      console.error('保存界面面板状态失败', error);
      useShellUiStore.getState().setStatusMessage('保存界面面板状态失败');
      throw error;
    }
    useWorkspaceStore.getState().setInterfacePanelVisible(true);
    useShellUiStore.getState().restoreCompactActivityPanel();
  });

  registry.register(COMMAND_IDS.workbenchFocusEditorGroup, async (...args: unknown[]) => {
    const groupId = args[0] as string | undefined;
    if (!groupId || useWorkspaceStore.getState().activeEditorGroupId === groupId) return;
    useWorkspaceStore.getState().focusEditorGroup(groupId);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.workbenchSaveState, async () => {
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });
}
