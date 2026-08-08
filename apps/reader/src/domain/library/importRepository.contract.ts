import { expect, it } from 'vitest';

import type { ImportRepository } from './importRepository';
import type { ReadingMaterial, SourceMetadata, StagedImport } from './material';

export interface ImportContractHarness {
  createRepository(): ImportRepository;
  /** 暂存一份内容并返回暂存句柄。语义:字节被复制到暂存区并计算指纹,源保持不变。 */
  stage(name: string, bytes: Uint8Array): Promise<StagedImport>;
  /** 登记一份外部封面图片源文件,供 setMaterialCover 读取。可选:不支持封面的 Harness 可省略。 */
  registerCoverSource?(name: string, bytes: Uint8Array): void;
}

/** TypeScript 导入契约:内存 Adapter 与 Tauri Adapter 必须通过同一组断言。 */
export function importRepositoryContract(harness: ImportContractHarness): void {
  it('提交后生成稳定 BookId 并可在书库中列出', async () => {
    const repository = harness.createRepository();
    const staged = await harness.stage('book.epub', encodeUtf8('epub-A'));

    const material = await repository.commitImport(staged, {
      title: '甲',
      author: '作者',
      language: 'zh',
    });

    expect(material.id).toBeTruthy();
    const list = await repository.listMaterials();
    const first = list[0];
    expect(list).toHaveLength(1);
    expect(first?.id).toBe(material.id);
    expect(first?.title).toBe('甲');
    expect(first?.author).toBe('作者');
    expect(first?.language).toBe('zh');
  });

  it('相同内容指纹只保留一份', async () => {
    const repository = harness.createRepository();
    const first = await harness.stage('a.epub', encodeUtf8('same-content'));
    const second = await harness.stage('b.epub', encodeUtf8('same-content'));

    const materialA = await repository.commitImport(first, { title: '甲', author: null, language: null });
    const materialB = await repository.commitImport(second, { title: '乙', author: null, language: null });

    expect(materialB.id).toBe(materialA.id);
    expect(await repository.listMaterials()).toHaveLength(1);
  });

  it('读取暂存文件返回暂存的原始字节', async () => {
    const repository = harness.createRepository();
    const staged = await harness.stage('book.epub', encodeUtf8('staged-bytes'));

    const bytes = await repository.readStagedFile(staged);

    expect(new TextDecoder().decode(bytes)).toBe('staged-bytes');
  });

  it('丢弃暂存文件后无法再读取,且不产生任何记录', async () => {
    const repository = harness.createRepository();
    const staged = await harness.stage('book.epub', encodeUtf8('content'));

    await repository.discardImport(staged);
    await expect(repository.readStagedFile(staged)).rejects.toThrow();
    expect(await repository.listMaterials()).toHaveLength(0);
  });

  it('丢弃一个不存在的暂存文件是幂等的', async () => {
    const repository = harness.createRepository();

    await expect(
      repository.discardImport({ id: 'missing', originalFileName: 'book.epub', fingerprint: 'f' }),
    ).resolves.toBeUndefined();
  });

  it('恢复后暂存文件被清理,无法再读取', async () => {
    const repository = harness.createRepository();
    const staged = await harness.stage('book.epub', encodeUtf8('content'));

    await repository.recoverImports();

    await expect(repository.readStagedFile(staged)).rejects.toThrow();
  });

  it('读取已提交托管文件返回提交时的原始字节', async () => {
    const repository = harness.createRepository();
    const staged = await harness.stage('book.epub', encodeUtf8('managed-bytes'));
    const material = await repository.commitImport(staged, {
      title: '甲',
      author: null,
      language: null,
    });

    const bytes = await repository.readManagedFile(material.id);

    expect(new TextDecoder().decode(bytes)).toBe('managed-bytes');
  });

  it('读取不存在的托管文件抛出错误', async () => {
    const repository = harness.createRepository();

    await expect(repository.readManagedFile('no-such-id')).rejects.toThrow();
  });

  it('暂存一个不存在的源文件抛出错误(磁盘错误边界)', async () => {
    const repository = harness.createRepository();

    await expect(repository.stageImport('/no/such/source.epub')).rejects.toThrow();
  });

  it('启动恢复会回滚未提交的 pending 导入且不产生任何记录', async () => {
    const repository = harness.createRepository();
    const staged = await harness.stage('pending.epub', encodeUtf8('pending-content'));

    await repository.recoverImports();

    expect(await repository.listMaterials()).toHaveLength(0);
    await expect(repository.readStagedFile(staged)).rejects.toThrow();
  });

  it('启动恢复不会删除已提交的 ready 阅读材料', async () => {
    const repository = harness.createRepository();
    const staged = await harness.stage('keep.epub', encodeUtf8('keep-me'));
    const material = await repository.commitImport(staged, {
      title: '保留',
      author: null,
      language: null,
    });

    await repository.recoverImports();

    expect(await repository.listMaterials()).toHaveLength(1);
    const bytes = await repository.readManagedFile(material.id);
    expect(new TextDecoder().decode(bytes)).toBe('keep-me');
  });
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}