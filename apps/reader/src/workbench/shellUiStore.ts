import { create } from 'zustand';

/** 外壳运行时反馈(状态栏文案等),不参与持久化。 */
export interface ShellUiStoreState {
  statusMessage: string;
  /** 正在编辑元数据的材料 ID;null 表示未打开元数据编辑器。 */
  metadataEditorMaterialId: string | null;
  /** 等待确认永久删除的材料 ID;null 表示未打开永久删除确认对话框。 */
  purgeMaterialId: string | null;
  setStatusMessage: (message: string) => void;
  clearStatusMessage: () => void;
  openMetadataEditor: (materialId: string) => void;
  closeMetadataEditor: () => void;
  openPurgeConfirm: (materialId: string) => void;
  closePurgeConfirm: () => void;
}

export const useShellUiStore = create<ShellUiStoreState>()((set) => ({
  statusMessage: '',
  metadataEditorMaterialId: null,
  purgeMaterialId: null,
  setStatusMessage: (message) => set({ statusMessage: message }),
  clearStatusMessage: () => set({ statusMessage: '' }),
  openMetadataEditor: (materialId) => set({ metadataEditorMaterialId: materialId }),
  closeMetadataEditor: () => set({ metadataEditorMaterialId: null }),
  openPurgeConfirm: (materialId) => set({ purgeMaterialId: materialId }),
  closePurgeConfirm: () => set({ purgeMaterialId: null }),
}));
