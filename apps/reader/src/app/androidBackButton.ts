export type AndroidBackSidebar = 'primary' | 'toc' | 'interface';

export interface AndroidBackState {
  compactLayout: boolean;
  visibleSidebars: AndroidBackSidebar[];
  activeViewId: string | null;
  activeViewSourceMode: boolean;
  activeSearchViewId: string | null;
  markdownDirtyCloseOpen: boolean;
  recoveryDialogOpen: boolean;
  versionMigrationDialogOpen: boolean;
  versionMigrationSnapshotDialogOpen: boolean;
  metadataDialogOpen: boolean;
  purgeDialogOpen: boolean;
  folderDeleteDialogOpen: boolean;
  externalLinkDialogOpen: boolean;
  noteDialogOpen: boolean;
  annotationPanelOpen: boolean;
}

export type AndroidBackAction =
  | { kind: 'closeSearch'; viewId: string }
  | { kind: 'closeSidebar'; sidebar: AndroidBackSidebar }
  | { kind: 'dismissMarkdownDirtyClose' }
  | { kind: 'dismissVersionMigration' }
  | { kind: 'dismissVersionMigrationSnapshots' }
  | { kind: 'dismissMetadataDialog' }
  | { kind: 'dismissPurgeDialog' }
  | { kind: 'dismissFolderDeleteDialog' }
  | { kind: 'dismissExternalLinkDialog' }
  | { kind: 'dismissNoteDialog' }
  | { kind: 'dismissAnnotationPanel' }
  | { kind: 'exitMarkdownSourceMode'; viewId: string }
  | { kind: 'stay' }
  | { kind: 'delegateToWebView' };

/**
 * Android 返回键只退出当前次级状态，不替用户选择“保存”或“丢弃”未保存内容。
 * 恢复快照对话框同样保持打开，避免系统返回造成静默丢弃。
 */
export function resolveAndroidBackAction(state: AndroidBackState): AndroidBackAction {
  if (state.markdownDirtyCloseOpen || state.recoveryDialogOpen) {
    return state.markdownDirtyCloseOpen
      ? { kind: 'dismissMarkdownDirtyClose' }
      : { kind: 'stay' };
  }
  if (state.versionMigrationDialogOpen) return { kind: 'dismissVersionMigration' };
  if (state.versionMigrationSnapshotDialogOpen) {
    return { kind: 'dismissVersionMigrationSnapshots' };
  }
  if (state.metadataDialogOpen) return { kind: 'dismissMetadataDialog' };
  if (state.purgeDialogOpen) return { kind: 'dismissPurgeDialog' };
  if (state.folderDeleteDialogOpen) return { kind: 'dismissFolderDeleteDialog' };
  if (state.externalLinkDialogOpen) return { kind: 'dismissExternalLinkDialog' };
  if (state.noteDialogOpen) return { kind: 'dismissNoteDialog' };
  if (state.annotationPanelOpen) return { kind: 'dismissAnnotationPanel' };
  if (state.activeSearchViewId) {
    return { kind: 'closeSearch', viewId: state.activeSearchViewId };
  }
  if (state.compactLayout) {
    const sidebar = state.visibleSidebars[0];
    if (sidebar) return { kind: 'closeSidebar', sidebar };
  }
  if (state.activeViewSourceMode && state.activeViewId) {
    return { kind: 'exitMarkdownSourceMode', viewId: state.activeViewId };
  }
  return { kind: 'delegateToWebView' };
}
