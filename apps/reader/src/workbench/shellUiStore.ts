import { create } from 'zustand';
import type { MarkdownRecoverySnapshot } from '../domain/library/importRepository';

/** 外壳运行时反馈(状态栏文案等),不参与持久化。 */
export interface ShellUiStoreState {
  statusMessage: string;
  /** 正在编辑元数据的材料 ID;null 表示未打开元数据编辑器。 */
  metadataEditorMaterialId: string | null;
  /** 等待确认永久删除的材料 ID;null 表示未打开永久删除确认对话框。 */
  purgeMaterialId: string | null;
  /** 等待确认打开的外部链接目标;null 表示未打开外部链接确认对话框。 */
  externalLinkUrl: string | null;
  /** 正在编辑排版的阅读视图 id;null 表示未打开排版设置对话框。 */
  typographyEditorViewId: string | null;
  /** 正在编辑笔记的批注(materialId + annotationId);null 表示未打开笔记编辑器。 */
  noteEditorTarget: { materialId: string; annotationId: string } | null;
  /** 等待脏 Markdown 视图关闭确认的 viewId;null 表示未打开脏文档关闭对话框。 */
  markdownDirtyCloseViewId: string | null;
  /** 脏文档对话框确认后要执行的动作:关闭视图或退出源码模式。 */
  markdownDirtyCloseAction: 'close' | 'exitSource' | null;
  /** 启动时待用户处理的 Markdown 恢复快照队列。 */
  markdownRecoverySnapshots: MarkdownRecoverySnapshot[];
  setStatusMessage: (message: string) => void;
  clearStatusMessage: () => void;
  openMetadataEditor: (materialId: string) => void;
  closeMetadataEditor: () => void;
  openPurgeConfirm: (materialId: string) => void;
  closePurgeConfirm: () => void;
  openExternalLinkConfirm: (url: string) => void;
  closeExternalLinkConfirm: () => void;
  openTypographyEditor: (viewId: string) => void;
  closeTypographyEditor: () => void;
  openNoteEditor: (materialId: string, annotationId: string) => void;
  closeNoteEditor: () => void;
  openMarkdownDirtyClose: (viewId: string, action: 'close' | 'exitSource') => void;
  closeMarkdownDirtyClose: () => void;
  setMarkdownRecoverySnapshots: (snapshots: MarkdownRecoverySnapshot[]) => void;
  removeMarkdownRecoverySnapshot: (materialId: string) => void;
}

export const useShellUiStore = create<ShellUiStoreState>()((set) => ({
  statusMessage: '',
  metadataEditorMaterialId: null,
  purgeMaterialId: null,
  externalLinkUrl: null,
  typographyEditorViewId: null,
  noteEditorTarget: null,
  markdownDirtyCloseViewId: null,
  markdownDirtyCloseAction: null,
  markdownRecoverySnapshots: [],
  setStatusMessage: (message) => set({ statusMessage: message }),
  clearStatusMessage: () => set({ statusMessage: '' }),
  openMetadataEditor: (materialId) => set({ metadataEditorMaterialId: materialId }),
  closeMetadataEditor: () => set({ metadataEditorMaterialId: null }),
  openPurgeConfirm: (materialId) => set({ purgeMaterialId: materialId }),
  closePurgeConfirm: () => set({ purgeMaterialId: null }),
  openExternalLinkConfirm: (url) => set({ externalLinkUrl: url }),
  closeExternalLinkConfirm: () => set({ externalLinkUrl: null }),
  openTypographyEditor: (viewId) => set({ typographyEditorViewId: viewId }),
  closeTypographyEditor: () => set({ typographyEditorViewId: null }),
  openNoteEditor: (materialId, annotationId) =>
    set({ noteEditorTarget: { materialId, annotationId } }),
  closeNoteEditor: () => set({ noteEditorTarget: null }),
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
}));
