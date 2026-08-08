import { expect, it } from 'vitest';

import type { Annotation } from './annotation';
import type { AnnotationRepository } from './annotationRepository';

export type AnnotationRepositoryFactory = () => AnnotationRepository;

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-1',
    materialId: 'material-1',
    anchor: {
      cfi: 'epubcfi(/6/4[chap])!/4/2/2/1:0',
      quote: '被选中的文字',
      before: '前文',
      after: '后文',
      documentVersion: 'fingerprint-1',
      recoveryState: 'resolved',
    },
    style: 'highlight',
    color: '#ffd54f',
    note: '',
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...overrides,
  };
}

/** TypeScript 批注契约:内存 Adapter 与 Tauri Adapter 必须通过同一组断言。 */
export function annotationRepositoryContract(
  makeRepository: AnnotationRepositoryFactory,
): void {
  it('保存后可读取到同一份批注', async () => {
    const repository = makeRepository();
    const annotation = makeAnnotation();

    await repository.saveAnnotation(annotation);

    const list = await repository.listByMaterial('material-1');
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(annotation);
  });

  it('批注按 BookId 归属,读取返回材料级集合而不混入其它材料', async () => {
    const repository = makeRepository();
    await repository.saveAnnotation(makeAnnotation({ id: 'a1', materialId: 'material-1' }));
    await repository.saveAnnotation(makeAnnotation({ id: 'a2', materialId: 'material-1' }));
    await repository.saveAnnotation(makeAnnotation({ id: 'b1', materialId: 'material-2' }));

    const list = await repository.listByMaterial('material-1');
    expect(list.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('编辑文字笔记后持久化,再次读取返回更新后的批注', async () => {
    const repository = makeRepository();
    const annotation = makeAnnotation();
    await repository.saveAnnotation(annotation);

    const updated = { ...annotation, note: '这是笔记', updatedAt: 2000 };
    await repository.saveAnnotation(updated);

    const list = await repository.listByMaterial('material-1');
    expect(list[0]?.note).toBe('这是笔记');
    expect(list[0]?.updatedAt).toBe(2000);
  });

  it('逻辑删除后不再出现在材料级集合中', async () => {
    const repository = makeRepository();
    await repository.saveAnnotation(makeAnnotation({ id: 'keep' }));
    await repository.saveAnnotation(makeAnnotation({ id: 'remove' }));

    await repository.deleteAnnotation('remove');

    const list = await repository.listByMaterial('material-1');
    expect(list.map((a) => a.id)).toEqual(['keep']);
  });

  it('删除不存在的批注是幂等的', async () => {
    const repository = makeRepository();

    await expect(repository.deleteAnnotation('no-such')).resolves.toBeUndefined();
  });
}