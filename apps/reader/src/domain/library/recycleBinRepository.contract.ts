import { expect, it } from 'vitest';

import {
  readManagedSourceBytes,
  type ImportContractHarness,
} from './importRepository.contract';

const COVER_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 回收站契约:内存 Adapter 与 Tauri Adapter 必须通过同一组断言。
 * 验证「普通删除移除正文副本但保留数据、恢复保留原 BookId、重新导入同指纹恢复原记录、永久删除清空」的领域语义。
 */
export function recycleBinRepositoryContract(harness: ImportContractHarness): void {
  async function stageOne(repository = harness.createRepository()) {
    const staged = await harness.stage('book.epub', encodeUtf8('recycle-content'));
    const material = await repository.commitImport(staged, {
      title: '来源标题',
      author: '来源作者',
      language: 'zh',
    });
    return { repository, material };
  }

  it('普通删除把材料移入回收站并从活跃书库隐藏,保留 BookId 与数据', async () => {
    const { repository, material } = await stageOne();
    harness.registerCoverSource?.('cover.png', COVER_PNG);
    await repository.applyMaterialMetadata(material.id, '整理标题', null);
    await repository.setMaterialCover(material.id, 'cover.png');

    const trashed = await repository.trashMaterial(material.id);

    expect(trashed.id).toBe(material.id);
    expect(trashed.title).toBe('整理标题');
    expect(await repository.listMaterials()).toHaveLength(0);

    const trash = await repository.listTrashed();
    expect(trash).toHaveLength(1);
    expect(trash[0]?.id).toBe(material.id);
    expect(trash[0]?.title).toBe('整理标题');
    // 正文副本按普通删除策略移除,用户数据与封面仍保留。
    await expect(repository.openManagedFileSource(material.id)).rejects.toThrow();
    expect(await repository.readCover(material.id)).not.toBeNull();
  });

  it('从回收站恢复后继续使用原 BookId 与全部阅读数据', async () => {
    const { repository, material } = await stageOne();
    await repository.applyMaterialMetadata(material.id, '整理标题', '整理作者');
    await repository.trashMaterial(material.id);

    const restored = await repository.restoreMaterial(material.id);

    expect(restored.id).toBe(material.id);
    expect(restored.title).toBe('整理标题');
    expect(restored.author).toBe('整理作者');
    expect(restored.source.title).toBe('来源标题');
    expect(restored.managedFileAvailable).toBe(true);
    expect(new TextDecoder().decode(await readManagedSourceBytes(repository, material.id))).toBe(
      'recycle-content',
    );
    expect(await repository.listMaterials()).toHaveLength(1);
    expect(await repository.listTrashed()).toHaveLength(0);
  });

  it('相同完整内容指纹可以重新关联既有材料并保留原 BookId', async () => {
    const { repository, material } = await stageOne();
    const replacement = await harness.stage('replacement.epub', encodeUtf8('recycle-content'));

    const relinked = await repository.relinkMaterial(material.id, replacement);

    expect(relinked.id).toBe(material.id);
    expect(relinked.fingerprint).toBe(material.fingerprint);
    expect(relinked.managedFileAvailable).toBe(true);
    expect(new TextDecoder().decode(await readManagedSourceBytes(repository, material.id))).toBe(
      'recycle-content',
    );
    await expect(repository.openManagedFileSource(replacement.id)).rejects.toThrow();
  });

  it('重新导入回收站中相同内容指纹时恢复原 BookId,而不是新建', async () => {
    const { repository, material } = await stageOne();
    await repository.applyMaterialMetadata(material.id, '整理标题', null);
    await repository.trashMaterial(material.id);

    const reimported = await harness.stage('copy.epub', encodeUtf8('recycle-content'));
    const recomitted = await repository.commitImport(reimported, {
      title: '不同标题',
      author: null,
      language: null,
    });

    expect(recomitted.id).toBe(material.id);
    expect(await repository.listTrashed()).toHaveLength(0);
    const active = await repository.listMaterials();
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(material.id);
    // 恢复原记录,保留既有覆盖。
    expect(active[0]?.title).toBe('整理标题');
  });

  it('永久删除清空回收站材料与托管内容,且不可恢复', async () => {
    const { repository, material } = await stageOne();
    harness.registerCoverSource?.('cover.png', COVER_PNG);
    await repository.setMaterialCover(material.id, 'cover.png');
    await repository.trashMaterial(material.id);

    await repository.purgeMaterial(material.id);

    expect(await repository.listTrashed()).toHaveLength(0);
    expect(await repository.listMaterials()).toHaveLength(0);
    await expect(repository.openManagedFileSource(material.id)).rejects.toThrow();
    expect(await repository.readCover(material.id)).toBeNull();
  });

  it('活跃书库中的材料不能被移入回收站两次或永久删除', async () => {
    const { repository, material } = await stageOne();
    await repository.trashMaterial(material.id);

    await expect(repository.trashMaterial(material.id)).rejects.toThrow();

    // 未在回收站的材料不能被永久删除。
    const activeHarness = await stageOne();
    await expect(activeHarness.repository.purgeMaterial(activeHarness.material.id)).rejects.toThrow();
  });

  it('永久删除不改变其它材料', async () => {
    const { repository, material } = await stageOne();
    const secondStaged = await harness.stage('other.epub', encodeUtf8('other-content'));
    const other = await repository.commitImport(secondStaged, {
      title: '其它',
      author: null,
      language: null,
    });
    await repository.trashMaterial(material.id);
    await repository.purgeMaterial(material.id);

    const active = await repository.listMaterials();
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(other.id);
  });
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
