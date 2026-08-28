import { create } from 'zustand';

import type { LibraryFolder } from '../domain/library/libraryFolder';
import type { ReadingMaterial } from '../domain/library/material';

/** 书库相关的可序列化 UI 状态。导入中的瞬时状态(importing)只用于界面反馈,不持久化。 */
export interface LibraryStoreState {
  folders: LibraryFolder[];
  materials: ReadingMaterial[];
  trashedMaterials: ReadingMaterial[];
  importing: boolean;
  setFolders: (folders: LibraryFolder[]) => void;
  setMaterials: (materials: ReadingMaterial[]) => void;
  setTrashedMaterials: (materials: ReadingMaterial[]) => void;
  setImporting: (importing: boolean) => void;
  /** 用平台返回的权威结果替换单个材料(写入失败时不会只更新界面)。 */
  updateMaterial: (material: ReadingMaterial) => void;
  /** 从活跃书库移除一份材料(移入回收站时调用)。 */
  removeMaterial: (materialId: string) => void;
  /** 从回收站移除一份材料(永久删除或恢复时调用)。 */
  removeTrashedMaterial: (materialId: string) => void;
  resetToDefault: () => void;
}

export const useLibraryStore = create<LibraryStoreState>()((set) => ({
  folders: [],
  materials: [],
  trashedMaterials: [],
  importing: false,
  setFolders: (folders) => set({ folders }),
  setMaterials: (materials) => set({ materials }),
  setTrashedMaterials: (materials) => set({ trashedMaterials: materials }),
  setImporting: (importing) => set({ importing }),
  updateMaterial: (material) =>
    set((state) => ({
      materials: state.materials.map((item) => (item.id === material.id ? material : item)),
    })),
  removeMaterial: (materialId) =>
    set((state) => ({
      materials: state.materials.filter((item) => item.id !== materialId),
    })),
  removeTrashedMaterial: (materialId) =>
    set((state) => ({
      trashedMaterials: state.trashedMaterials.filter((item) => item.id !== materialId),
    })),
  resetToDefault: () => set({ folders: [], materials: [], trashedMaterials: [], importing: false }),
}));
