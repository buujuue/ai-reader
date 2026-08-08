import { create } from 'zustand';

import type { Annotation } from '../domain/annotation/annotation';

/**
 * 批注运行时 Store:按材料维护批注集合。批注是材料级实体,以 BookId 为键,
 * 不携带 ReadingView 标识。加载、增删改都会更新本 Store,并交给绘制层把
 * 高亮画到对应材料的开放阅读视图覆盖层上。
 */
export interface AnnotationStoreState {
  /** 材料 → 批注集合。键为 BookId。 */
  byMaterial: Record<string, Annotation[]>;
  /** 用平台返回的权威结果替换某材料的全部批注(加载/刷新)。 */
  setMaterialAnnotations: (materialId: string, annotations: Annotation[]) => void;
  /** 新增或更新一条批注(按 id 幂等)。 */
  upsertAnnotation: (annotation: Annotation) => void;
  /** 从某材料集合中移除一条批注(逻辑删除后不再展示)。 */
  removeAnnotation: (materialId: string, annotationId: string) => void;
  /** 读取某材料的批注集合。 */
  getMaterialAnnotations: (materialId: string) => Annotation[];
  resetToDefault: () => void;
}

export const useAnnotationStore = create<AnnotationStoreState>()((set, get) => ({
  byMaterial: {},

  setMaterialAnnotations: (materialId, annotations) =>
    set((state) => ({
      byMaterial: { ...state.byMaterial, [materialId]: annotations },
    })),

  upsertAnnotation: (annotation) =>
    set((state) => {
      const existing = state.byMaterial[annotation.materialId] ?? [];
      const index = existing.findIndex((item) => item.id === annotation.id);
      const next =
        index >= 0
          ? existing.map((item) => (item.id === annotation.id ? annotation : item))
          : [...existing, annotation];
      return { byMaterial: { ...state.byMaterial, [annotation.materialId]: next } };
    }),

  removeAnnotation: (materialId, annotationId) =>
    set((state) => {
      const existing = state.byMaterial[materialId] ?? [];
      return {
        byMaterial: {
          ...state.byMaterial,
          [materialId]: existing.filter((item) => item.id !== annotationId),
        },
      };
    }),

  getMaterialAnnotations: (materialId) => get().byMaterial[materialId] ?? [],

  resetToDefault: () => set({ byMaterial: {} }),
}));