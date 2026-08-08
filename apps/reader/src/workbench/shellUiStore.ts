import { create } from 'zustand';

/** 外壳运行时反馈(状态栏文案等),不参与持久化。 */
export interface ShellUiStoreState {
  statusMessage: string;
  /** 正在编辑元数据的材料 ID;null 表示未打开元数据编辑器。 */
  metadataEditorMaterialId: string | null;
  setStatusMessage: (message: string) => void;
  clearStatusMessage: () => void;
  openMetadataEditor: (materialId: string) => void;
  closeMetadataEditor: () => void;
}

export const useShellUiStore = create<ShellUiStoreState>()((set) => ({
  statusMessage: '',
  metadataEditorMaterialId: null,
  setStatusMessage: (message) => set({ statusMessage: message }),
  clearStatusMessage: () => set({ statusMessage: '' }),
  openMetadataEditor: (materialId) => set({ metadataEditorMaterialId: materialId }),
  closeMetadataEditor: () => set({ metadataEditorMaterialId: null }),
}));
