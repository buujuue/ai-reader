import type { Annotation } from './annotation';
import type { AnnotationRepository } from './annotationRepository';

const STORAGE_KEY = 'ai-reader.annotations';

/**
 * localStorage 批注 Adapter:浏览器降级开发时把批注持久化到 localStorage,
 * 使页面 reload(重启)后批注仍可跨会话恢复,与 Tauri SQLite 的行为对齐。
 * 契约与内存 Adapter 相同:批注按 materialId 归属,逻辑删除保留记录但标记 deletedAt。
 *
 * 依赖方负责保证材料身份稳定(见内存导入 Adapter 的内容寻址 id),否则
 * 跨会话的 materialId 对不上,批注无法关联到重新打开的材料。
 */
export function createLocalStorageAnnotationRepository(
  storage: Pick<Storage, 'getItem' | 'setItem'> = defaultStorage(),
): AnnotationRepository {
  function readAll(): Annotation[] {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Annotation[]) : [];
    } catch {
      return [];
    }
  }

  function writeAll(annotations: Annotation[]): void {
    storage.setItem(STORAGE_KEY, JSON.stringify(annotations));
  }

  return {
    async listByMaterial(materialId: string): Promise<Annotation[]> {
      return readAll()
        .filter((annotation) => annotation.materialId === materialId && annotation.deletedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async listDeletedByMaterial(materialId: string): Promise<Annotation[]> {
      return readAll()
        .filter((annotation) => annotation.materialId === materialId && annotation.deletedAt !== null)
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async saveAnnotation(annotation: Annotation): Promise<Annotation> {
      const all = readAll();
      const index = all.findIndex((item) => item.id === annotation.id);
      if (index >= 0) {
        all[index] = { ...annotation };
      } else {
        all.push({ ...annotation });
      }
      writeAll(all);
      return { ...annotation };
    },

    async saveAnnotations(annotations: readonly Annotation[]): Promise<Annotation[]> {
      if (annotations.length === 0) return [];
      const all = readAll();
      const next = [...all];
      for (const annotation of annotations) {
        const index = next.findIndex((item) => item.id === annotation.id);
        if (index >= 0) next[index] = { ...annotation };
        else next.push({ ...annotation });
      }
      writeAll(next);
      return annotations.map((annotation) => ({ ...annotation }));
    },

    async deleteAnnotation(annotationId: string): Promise<void> {
      const all = readAll();
      const index = all.findIndex((item) => item.id === annotationId);
      if (index < 0) {
        return;
      }
      all[index] = { ...all[index]!, deletedAt: Date.now() };
      writeAll(all);
    },

    async restoreAnnotation(annotationId: string): Promise<Annotation | null> {
      const all = readAll();
      const index = all.findIndex((item) => item.id === annotationId && item.deletedAt !== null);
      if (index < 0) return null;
      const restored = { ...all[index]!, deletedAt: null, updatedAt: Date.now() };
      all[index] = restored;
      writeAll(all);
      return { ...restored };
    },
  };
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  throw new Error('localStorage 批注 Adapter 需要可用的 localStorage');
}
