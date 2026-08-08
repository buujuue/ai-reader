import type { Annotation } from './annotation';
import type { AnnotationRepository } from './annotationRepository';

/**
 * 内存批注 Adapter:不启动 Tauri 时用于浏览器降级开发与领域契约测试。
 * 批注按 materialId 归属并持久到一个内存 Map;逻辑删除保留记录但标记 deletedAt。
 */
export function createInMemoryAnnotationRepository(): AnnotationRepository {
  const store = new Map<string, Annotation>();

  return {
    async listByMaterial(materialId: string): Promise<Annotation[]> {
      return [...store.values()]
        .filter((annotation) => annotation.materialId === materialId && annotation.deletedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async saveAnnotation(annotation: Annotation): Promise<Annotation> {
      store.set(annotation.id, { ...annotation });
      return { ...annotation };
    },

    async deleteAnnotation(annotationId: string): Promise<void> {
      const annotation = store.get(annotationId);
      if (!annotation) {
        return;
      }
      store.set(annotationId, { ...annotation, deletedAt: Date.now() });
    },
  };
}