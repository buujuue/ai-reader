export const COMMAND_IDS = {
  workbenchTogglePrimarySidebar: 'workbench.togglePrimarySidebar',
  workbenchFocusLibraryFilter: 'workbench.focusLibraryFilter',
  workbenchOpenAnnotationPanel: 'workbench.openAnnotationPanel',
  workbenchSetPrimaryMaterial: 'workbench.setPrimaryMaterial',
  workbenchToggleToc: 'workbench.toggleToc',
  workbenchSetActivityPanelWidth: 'workbench.setActivityPanelWidth',
  workbenchSetLibraryFolderExpanded: 'workbench.setLibraryFolderExpanded',
  workbenchSaveState: 'workbench.saveState',
  appBack: 'app.back',
  shellDismissDialog: 'shell.dismissDialog',
  workbenchFocusEditorGroup: 'workbench.focusEditorGroup',
  workbenchSplitEditorGroupRight: 'workbench.splitEditorGroupRight',
  workbenchSplitEditorGroupDown: 'workbench.splitEditorGroupDown',
  readerOpenTypography: 'reader.typography.open',
  libraryImport: 'library.import',
  libraryPreviewVersionMigration: 'library.previewVersionMigration',
  libraryCommitVersionMigration: 'library.commitVersionMigration',
  libraryCancelVersionMigration: 'library.cancelVersionMigration',
  libraryListVersionMigrationSnapshots: 'library.listVersionMigrationSnapshots',
  libraryRestoreVersionMigrationSnapshot: 'library.restoreVersionMigrationSnapshot',
  libraryClearVersionMigrationSnapshot: 'library.clearVersionMigrationSnapshot',
  libraryRefresh: 'library.refresh',
  libraryCreateFolder: 'library.createFolder',
  libraryRenameFolder: 'library.renameFolder',
  libraryOpenBook: 'library.openBook',
  libraryUpdateMetadata: 'library.updateMetadata',
  librarySetCover: 'library.setCover',
  libraryRemoveCover: 'library.removeCover',
  libraryRestoreMetadata: 'library.restoreMetadata',
  libraryTrash: 'library.trash',
  libraryRestoreFromTrash: 'library.restoreFromTrash',
  libraryPurge: 'library.purge',
  libraryRelink: 'library.relink',
  libraryExportBackup: 'library.exportBackup',
  libraryRestoreBackup: 'library.restoreBackup',
  readerNextPage: 'reader.nextPage',
  readerPrevPage: 'reader.prevPage',
  readerActivateView: 'reader.activateView',
  readerCloseView: 'reader.closeView',
  readerRestoreView: 'reader.restoreView',
  readerGoToHref: 'reader.goToHref',
  readerBack: 'reader.back',
  readerForward: 'reader.forward',
  readerOpenExternalUrl: 'reader.openExternalUrl',
  readerSearchOpen: 'reader.search.open',
  readerSearchClose: 'reader.search.close',
  readerSearchRun: 'reader.search.run',
  readerSearchToggleCase: 'reader.search.toggleCase',
  readerSearchToggleMode: 'reader.search.toggleMode',
  readerSearchNext: 'reader.search.next',
  readerSearchPrev: 'reader.search.prev',
  readerSearchGoTo: 'reader.search.goTo',
  readerApplyTypography: 'reader.typography.apply',
  readerResetTypography: 'reader.typography.reset',
  readerSetGlobalTypography: 'reader.typography.setGlobal',
  readerSetPdfViewport: 'reader.pdf.viewport',
  readerSetPdfFlow: 'reader.pdf.flow',
  annotationLoadForMaterial: 'annotation.loadForMaterial',
  annotationCreateHighlight: 'annotation.createHighlight',
  annotationCreatePdfArea: 'annotation.createPdfArea',
  annotationUpdateNote: 'annotation.updateNote',
  annotationOpenNoteEditor: 'annotation.openNoteEditor',
  annotationDelete: 'annotation.delete',
  annotationRestore: 'annotation.restore',
  annotationGoTo: 'annotation.goTo',
  annotationExportMarkdown: 'annotation.exportMarkdown',
  markdownToggleSourceMode: 'markdown.toggleSourceMode',
  markdownSave: 'markdown.save',
  markdownDiscard: 'markdown.discard',
  markdownCloseDirty: 'markdown.closeDirty',
  markdownUpdateBuffer: 'markdown.updateBuffer',
  markdownCheckRecoveries: 'markdown.recovery.check',
  markdownResolveRecovery: 'markdown.recovery.resolve',
  markdownFlushRecoveries: 'markdown.recovery.flush',
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

export type CommandHandler = (...args: unknown[]) => unknown;

export class UnknownCommandError extends Error {
  constructor(commandId: string) {
    super(`未注册的命令:${commandId}`);
    this.name = 'UnknownCommandError';
  }
}

export class DuplicateCommandError extends Error {
  constructor(commandId: string) {
    super(`命令已注册,不允许重复注册:${commandId}`);
    this.name = 'DuplicateCommandError';
  }
}

/**
 * Command Registry:所有按钮、菜单、键盘和触摸 Adapter 都通过稳定 Command ID
 * 执行用户意图,避免为同一意图实现多套逻辑。
 */
export class CommandRegistry {
  private readonly handlers = new Map<CommandId, CommandHandler>();

  register(commandId: CommandId, handler: CommandHandler): () => void {
    if (this.handlers.has(commandId)) {
      throw new DuplicateCommandError(commandId);
    }
    this.handlers.set(commandId, handler);
    return () => {
      this.handlers.delete(commandId);
    };
  }

  has(commandId: CommandId): boolean {
    return this.handlers.has(commandId);
  }

  async execute(commandId: CommandId, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(commandId);
    if (!handler) {
      throw new UnknownCommandError(commandId);
    }
    return await handler(...args);
  }
}
