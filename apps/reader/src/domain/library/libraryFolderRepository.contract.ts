import { expect, it } from 'vitest';

import type { LibraryFolderRepository } from './libraryFolderRepository';

export type LibraryFolderRepositoryFactory = () => LibraryFolderRepository;

/** 内存与 Tauri 文件夹 Adapter 共用的前端契约。 */
export function libraryFolderRepositoryContract(makeRepository: LibraryFolderRepositoryFactory): void {
  it('空库返回空文件夹列表', async () => {
    await expect(makeRepository().listFolders()).resolves.toEqual([]);
  });

  it('创建后可列出稳定 ID、名称和父级', async () => {
    const repository = makeRepository();
    const folder = await repository.createFolder('  文史  ', null);

    expect(folder).toMatchObject({ name: '文史', parentId: null });
    expect(folder.id).toBeTruthy();
    await expect(repository.listFolders()).resolves.toEqual([folder]);
  });

  it('保留空文件夹并按同级名称排序', async () => {
    const repository = makeRepository();
    const z = await repository.createFolder('哲学', null);
    const a = await repository.createFolder('历史', null);
    const child = await repository.createFolder('章节', a.id);

    await expect(repository.listFolders()).resolves.toEqual([a, z, child]);
  });

  it('同一父级重名被拒绝且不同父级允许同名', async () => {
    const repository = makeRepository();
    const first = await repository.createFolder('阅读', null);
    const second = await repository.createFolder('笔记', null);

    await expect(repository.createFolder(' 阅读 ', null)).rejects.toThrow('已有同名文件夹');
    await expect(repository.createFolder('阅读', first.id)).resolves.toMatchObject({
      name: '阅读',
      parentId: first.id,
    });
    await repository.createFolder('Science', first.id);
    await expect(repository.createFolder('science', first.id)).rejects.toThrow('已有同名文件夹');
    await repository.createFolder('Ä', first.id);
    await expect(repository.createFolder('ä', first.id)).rejects.toThrow('已有同名文件夹');
    await expect(repository.createFolder('阅读', second.id)).resolves.toMatchObject({
      name: '阅读',
      parentId: second.id,
    });
    await expect(repository.createFolder('science', second.id)).resolves.toMatchObject({
      name: 'science',
      parentId: second.id,
    });
  });

  it('改名保持父级并拒绝同级冲突', async () => {
    const repository = makeRepository();
    const parent = await repository.createFolder('父级', null);
    const child = await repository.createFolder('旧名', parent.id);
    await repository.createFolder('已占用', parent.id);

    await expect(repository.renameFolder(child.id, ' 新名 ')).resolves.toEqual({
      ...child,
      name: '新名',
    });
    await expect(repository.renameFolder(child.id, '已占用')).rejects.toThrow('已有同名文件夹');
    await expect(repository.listFolders()).resolves.toContainEqual({
      ...child,
      name: '新名',
    });
  });

  it('第五层可以创建但第六层被拒绝', async () => {
    const repository = makeRepository();
    let parentId: string | null = null;
    for (let depth = 1; depth <= 5; depth += 1) {
      parentId = (await repository.createFolder(`第${depth}层`, parentId)).id;
    }

    await expect(repository.createFolder('第六层', parentId)).rejects.toThrow('已达到最多五层');
  });

  it.each([
    ['', '文件夹名称不能为空'],
    ['a/b', '文件夹名称不能包含路径分隔符'],
    ['a\u0000b', '文件夹名称不能包含控制字符'],
  ])('创建非法名称 %j 返回中文错误', async (name, message) => {
    await expect(makeRepository().createFolder(name, null)).rejects.toThrow(message);
  });
}
