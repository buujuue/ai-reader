import { describe, it, expect } from 'vitest';

import { annotationRepositoryContract } from './annotationRepository.contract';
import { createLocalStorageAnnotationRepository } from './localStorageAnnotationRepository';

/** 内存 Storage 桩:为契约测试提供与浏览器 localStorage 兼容的读写。 */
function createStorageStub(): Storage & { getItem: (k: string) => string | null } {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

describe('AnnotationRepository 契约 · localStorage Adapter', () => {
  annotationRepositoryContract(() =>
    createLocalStorageAnnotationRepository(createStorageStub()),
  );
});

describe('localStorage AnnotationRepository', () => {
  it('跨「实例」持久化:同一 storage 下新实例仍能读到已保存批注', async () => {
    const storage = createStorageStub();
    const first = createLocalStorageAnnotationRepository(storage);
    await first.saveAnnotation({
      id: 'a1',
      materialId: 'material-1',
      anchor: {
        cfi: 'epubcfi(/6/4)!/4/2/2/1:0',
        quote: '文字',
        before: '',
        after: '',
        documentVersion: 'fp-1',
        recoveryState: 'resolved',
      },
      style: 'highlight',
      color: '#ffd54f',
      note: '',
      createdAt: 1000,
      updatedAt: 1000,
      deletedAt: null,
    });

    const second = createLocalStorageAnnotationRepository(storage);
    const list = await second.listByMaterial('material-1');
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('a1');
  });

  it('损坏的持久化数据按空集合处理,不抛出', async () => {
    const storage = createStorageStub();
    storage.setItem('ai-reader.annotations', '{not json');
    const repository = createLocalStorageAnnotationRepository(storage);
    await expect(repository.listByMaterial('material-1')).resolves.toEqual([]);
  });
});