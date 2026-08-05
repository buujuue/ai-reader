import { create } from 'zustand';

import type { ReadingMaterial } from '../domain/library/material';

/** 书库相关的可序列化 UI 状态。导入中的瞬时状态(importing)只用于界面反馈,不持久化。 */
export interface LibraryStoreState {
  materials: ReadingMaterial[];
  importing: boolean;
  setMaterials: (materials: ReadingMaterial[]) => void;
  setImporting: (importing: boolean) => void;
  resetToDefault: () => void;
}

export const useLibraryStore = create<LibraryStoreState>()((set) => ({
  materials: [],
  importing: false,
  setMaterials: (materials) => set({ materials }),
  setImporting: (importing) => set({ importing }),
  resetToDefault: () => set({ materials: [], importing: false }),
}));
