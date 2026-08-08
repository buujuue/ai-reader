import { expect, it } from 'vitest';

import type { ImportContractHarness } from './importRepository.contract';

const COVER_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 元数据覆盖契约:内存 Adapter 与 Tauri Adapter 必须通过同一组断言。
 * 验证「来源快照不可编辑、覆盖值独立保存、覆盖优先/来源兜底」的有效元数据合并语义。
 */
export function metadataRepositoryContract(harness: ImportContractHarness): void {
  async function stageOne(repository = harness.createRepository()) {
    const staged = await harness.stage('book.epub', encodeUtf8('metadata-content'));
    const material = await repository.commitImport(staged, {
      title: '来源标题',
      author: '来源作者',
      language: 'zh',
    });
    return { repository, material, source: material.source };
  }

  function registerCover(name = 'cover.png'): string {
    harness.registerCoverSource?.(name, COVER_PNG);
    return name;
  }

  it('覆盖标题与作者后,有效元数据优先于来源,来源快照保持不变', async () => {
    const { repository, material, source } = await stageOne();

    const updated = await repository.applyMaterialMetadata(material.id, '整理标题', '整理作者');

    expect(updated.title).toBe('整理标题');
    expect(updated.author).toBe('整理作者');
    expect(updated.source).toEqual(source);
    expect(updated.override.title).toBe('整理标题');
    expect(updated.override.author).toBe('整理作者');

    const listed = await repository.listMaterials();
    const first = listed[0];
    expect(first?.title).toBe('整理标题');
    expect(first?.author).toBe('整理作者');
    expect(first?.source).toEqual(source);
  });

  it('只覆盖作者时,标题保持来源值', async () => {
    const { repository, material } = await stageOne();

    const updated = await repository.applyMaterialMetadata(material.id, null, '新作者');

    expect(updated.title).toBe('来源标题');
    expect(updated.author).toBe('新作者');
    expect(updated.override.title).toBeNull();
    expect(updated.override.author).toBe('新作者');
  });

  it('清除覆盖后回落到来源标题与作者', async () => {
    const { repository, material } = await stageOne();
    await repository.applyMaterialMetadata(material.id, '整理标题', '整理作者');

    const restored = await repository.applyMaterialMetadata(material.id, null, null);

    expect(restored.title).toBe('来源标题');
    expect(restored.author).toBe('来源作者');
    expect(restored.override.title).toBeNull();
    expect(restored.override.author).toBeNull();
  });

  it('设置自定义封面后 coverSource 生效,且不影响内容身份与来源元数据', async () => {
    const { repository, material, source } = await stageOne();
    registerCover();

    const updated = await repository.setMaterialCover(material.id, 'cover.png');

    expect(updated.coverSource).toBeTruthy();
    expect(updated.fingerprint).toBe(material.fingerprint);
    expect(updated.sourceFileName).toBe(material.sourceFileName);
    expect(updated.source).toEqual(source);

    const listed = await repository.listMaterials();
    expect(listed[0]?.coverSource).toBe(updated.coverSource);
  });

  it('移除自定义封面后 coverSource 与覆盖均回落', async () => {
    const { repository, material } = await stageOne();
    registerCover();
    await repository.setMaterialCover(material.id, 'cover.png');

    const removed = await repository.removeMaterialCover(material.id);

    expect(removed.coverSource).toBeNull();
    expect(removed.override.coverSource).toBeNull();
  });

  it('一键恢复来源元数据清除标题、作者与封面的全部覆盖', async () => {
    const { repository, material, source } = await stageOne();
    registerCover();
    await repository.applyMaterialMetadata(material.id, '整理标题', '整理作者');
    await repository.setMaterialCover(material.id, 'cover.png');

    const restored = await repository.restoreSourceMetadata(material.id);

    expect(restored.title).toBe(source.title);
    expect(restored.author).toBe(source.author);
    expect(restored.coverSource).toBeNull();
    expect(restored.override).toEqual({ title: null, author: null, coverSource: null });
  });

  it('覆盖不改变托管文件字节(内容身份与锚点稳定)', async () => {
    const { repository, material } = await stageOne();
    const before = await repository.readManagedFile(material.id);

    const updated = await repository.applyMaterialMetadata(material.id, '整理标题', null);

    expect(updated.fingerprint).toBe(material.fingerprint);
    expect(updated.sourceFileName).toBe('book.epub');
    const after = await repository.readManagedFile(material.id);
    expect(new TextDecoder().decode(after)).toBe(new TextDecoder().decode(before));
  });
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}