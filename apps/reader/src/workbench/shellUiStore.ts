import { create } from 'zustand';

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
  /** 目录面板是否可见(运行时状态,不持久化)。 */
  tocVisible: boolean;
  /** 正在编辑笔记的批注(materialId + annotationId);null 表示未打开笔记编辑器。 */
  noteEditorTarget: { materialId: string; annotationId: string } | null;
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
  setTocVisible: (visible: boolean) => void;
  toggleToc: () => void;
}

export const useShellUiStore = create<ShellUiStoreState>()((set) => ({
  statusMessage: '',
  metadataEditorMaterialId: null,
  purgeMaterialId: null,
  externalLinkUrl: null,
  typographyEditorViewId: null,
  tocVisible: false,
  noteEditorTarget: null,
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
  setTocVisible: (visible) => set({ tocVisible: visible }),
  toggleToc: () => set((state) => ({ tocVisible: !state.tocVisible })),
}));
