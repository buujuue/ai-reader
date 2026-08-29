import { create } from 'zustand';
import type { MarkdownRecoverySnapshot } from '../domain/library/importRepository';
import type { VersionMigrationPreview } from '../domain/library/versionMigration';
import type { VersionMigrationCandidate } from '../domain/library/versionMigration';
import type { VersionMigrationSnapshot } from '../domain/library/versionMigrationPersistence';

/** 外壳运行时反馈(状态栏文案等),不参与持久化。 */
export interface ShellUiStoreState {
  statusMessage: string;
  /** 正在编辑元数据的材料 ID;null 表示未打开元数据编辑器。 */
  metadataEditorMaterialId: string | null;
  /** 等待确认永久删除的材料 ID;null 表示未打开永久删除确认对话框。 */
  purgeMaterialId: string | null;
  /** 等待确认删除的书库文件夹 ID;null 表示未打开文件夹删除确认对话框。 */
  folderDeleteId: string | null;
  folderDeleteReturnFocus: HTMLElement | null;
  /** 等待确认打开的外部链接目标;null 表示未打开外部链接确认对话框。 */
  externalLinkUrl: string | null;
  /** 正在编辑排版的阅读视图 id;null 表示未打开排版设置对话框。 */
  typographyEditorViewId: string | null;
  /** 正在编辑笔记的批注(materialId + annotationId);null 表示未打开笔记编辑器。 */
  noteEditorTarget: { materialId: string; annotationId: string } | null;
  /** 最近一次成功软删除的批注,供状态栏提供一次性撤销入口。 */
  annotationUndoTarget: { materialId: string; annotationId: string } | null;
  /** 当前打开的材料批注面板归属;面板状态只属于运行时外壳。 */
  annotationPanelMaterialId: string | null;
  annotationPanelReturnFocus: HTMLElement | null;
  /** 紧凑布局打开材料后临时收起活动面板,不改写 Workspace State。 */
  compactActivityPanelDismissed: boolean;
  compactActivityPanelDismissRequestToken: number;
  /** 书库筛选框聚焦请求序号,用于让菜单命令驱动 UI 聚焦。 */
  libraryFilterFocusToken: number;
  /** 等待脏 Markdown 视图关闭确认的 viewId;null 表示未打开脏文档关闭对话框。 */
  markdownDirtyCloseViewId: string | null;
  /** 脏文档对话框确认后要执行的动作:关闭视图或退出源码模式。 */
  markdownDirtyCloseAction: 'close' | 'exitSource' | null;
  /** 启动时待用户处理的 Markdown 恢复快照队列。 */
  markdownRecoverySnapshots: MarkdownRecoverySnapshot[];
  /** 等待用户明确选择的 EPUB 版本迁移候选。暂存文件在确认或取消前保留。 */
  versionMigrationCandidates: VersionMigrationCandidate[];
  versionMigrationPreview: VersionMigrationPreview | null;
  versionMigrationSnapshots: VersionMigrationSnapshot[];
  versionMigrationSnapshotDialogOpen: boolean;
  setStatusMessage: (message: string) => void;
  clearStatusMessage: () => void;
  openMetadataEditor: (materialId: string) => void;
  closeMetadataEditor: () => void;
  openPurgeConfirm: (materialId: string) => void;
  closePurgeConfirm: () => void;
  openFolderDeleteConfirm: (folderId: string, returnFocusTarget?: HTMLElement | null) => void;
  closeFolderDeleteConfirm: () => void;
  openExternalLinkConfirm: (url: string) => void;
  closeExternalLinkConfirm: () => void;
  openTypographyEditor: (viewId: string) => void;
  closeTypographyEditor: () => void;
  openNoteEditor: (materialId: string, annotationId: string) => void;
  closeNoteEditor: () => void;
  setAnnotationUndoTarget: (target: { materialId: string; annotationId: string } | null) => void;
  openAnnotationPanel: (materialId: string, returnFocusTarget?: HTMLElement | null) => void;
  closeAnnotationPanel: () => void;
  dismissCompactActivityPanel: () => void;
  requestCompactActivityPanelDismissal: () => void;
  restoreCompactActivityPanel: () => void;
  requestLibraryFilterFocus: () => void;
  openMarkdownDirtyClose: (viewId: string, action: 'close' | 'exitSource') => void;
  closeMarkdownDirtyClose: () => void;
  setMarkdownRecoverySnapshots: (snapshots: MarkdownRecoverySnapshot[]) => void;
  removeMarkdownRecoverySnapshot: (materialId: string) => void;
  setVersionMigrationCandidates: (candidates: VersionMigrationCandidate[]) => void;
  setVersionMigrationPreview: (preview: VersionMigrationPreview | null) => void;
  setVersionMigrationSnapshots: (snapshots: VersionMigrationSnapshot[]) => void;
  openVersionMigrationSnapshots: () => void;
  closeVersionMigrationSnapshots: () => void;
}

export const useShellUiStore = create<ShellUiStoreState>()((set) => ({
  statusMessage: '',
  metadataEditorMaterialId: null,
  purgeMaterialId: null,
  folderDeleteId: null,
  folderDeleteReturnFocus: null,
  externalLinkUrl: null,
  typographyEditorViewId: null,
  noteEditorTarget: null,
  annotationUndoTarget: null,
  annotationPanelMaterialId: null,
  annotationPanelReturnFocus: null,
  compactActivityPanelDismissed: false,
  compactActivityPanelDismissRequestToken: 0,
  libraryFilterFocusToken: 0,
  markdownDirtyCloseViewId: null,
  markdownDirtyCloseAction: null,
  markdownRecoverySnapshots: [],
  versionMigrationCandidates: [],
  versionMigrationPreview: null,
  versionMigrationSnapshots: [],
  versionMigrationSnapshotDialogOpen: false,
  setStatusMessage: (message) => set({ statusMessage: message }),
  clearStatusMessage: () => set({ statusMessage: '' }),
  openMetadataEditor: (materialId) => set({ metadataEditorMaterialId: materialId }),
  closeMetadataEditor: () => set({ metadataEditorMaterialId: null }),
  openPurgeConfirm: (materialId) => set({ purgeMaterialId: materialId }),
  closePurgeConfirm: () => set({ purgeMaterialId: null }),
  openFolderDeleteConfirm: (folderId, returnFocusTarget) =>
    set({ folderDeleteId: folderId, folderDeleteReturnFocus: returnFocusTarget ?? null }),
  closeFolderDeleteConfirm: () => set({ folderDeleteId: null, folderDeleteReturnFocus: null }),
  openExternalLinkConfirm: (url) => set({ externalLinkUrl: url }),
  closeExternalLinkConfirm: () => set({ externalLinkUrl: null }),
  openTypographyEditor: (viewId) => set({ typographyEditorViewId: viewId }),
  closeTypographyEditor: () => set({ typographyEditorViewId: null }),
  openNoteEditor: (materialId, annotationId) =>
    set({ noteEditorTarget: { materialId, annotationId } }),
  closeNoteEditor: () => set({ noteEditorTarget: null }),
  setAnnotationUndoTarget: (annotationUndoTarget) => set({ annotationUndoTarget }),
  openAnnotationPanel: (materialId, returnFocusTarget) =>
    set({
      annotationPanelMaterialId: materialId,
      annotationPanelReturnFocus:
        returnFocusTarget ??
        (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null),
      compactActivityPanelDismissed: false,
    }),
  closeAnnotationPanel: () =>
    set({ annotationPanelMaterialId: null, annotationPanelReturnFocus: null }),
  dismissCompactActivityPanel: () => set({ compactActivityPanelDismissed: true }),
  requestCompactActivityPanelDismissal: () =>
    set((state) => ({
      compactActivityPanelDismissRequestToken: state.compactActivityPanelDismissRequestToken + 1,
    })),
  restoreCompactActivityPanel: () => set({ compactActivityPanelDismissed: false }),
  requestLibraryFilterFocus: () =>
    set((state) => ({ libraryFilterFocusToken: state.libraryFilterFocusToken + 1 })),
  openMarkdownDirtyClose: (viewId, action) =>
    set({ markdownDirtyCloseViewId: viewId, markdownDirtyCloseAction: action }),
  closeMarkdownDirtyClose: () => set({ markdownDirtyCloseViewId: null, markdownDirtyCloseAction: null }),
  setMarkdownRecoverySnapshots: (markdownRecoverySnapshots) => set({ markdownRecoverySnapshots }),
  removeMarkdownRecoverySnapshot: (materialId) =>
    set((state) => ({
      markdownRecoverySnapshots: state.markdownRecoverySnapshots.filter(
        (snapshot) => snapshot.materialId !== materialId,
      ),
    })),
  setVersionMigrationCandidates: (versionMigrationCandidates) =>
    set({ versionMigrationCandidates }),
  setVersionMigrationPreview: (versionMigrationPreview) => set({ versionMigrationPreview }),
  setVersionMigrationSnapshots: (versionMigrationSnapshots) => set({ versionMigrationSnapshots }),
  openVersionMigrationSnapshots: () => set({ versionMigrationSnapshotDialogOpen: true }),
  closeVersionMigrationSnapshots: () => set({ versionMigrationSnapshotDialogOpen: false }),
}));
