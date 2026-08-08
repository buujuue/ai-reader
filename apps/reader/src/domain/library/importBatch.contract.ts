import { expect, it } from 'vitest';

import type { FilePicker } from '../../app/filePicker';
import { importBooks } from '../../workbench/importBook';
import { buildEpub } from './epub/zipWriter';
import type { ImportRepository } from './importRepository';

export interface ImportBatchContractHarness {
  createRepository(): ImportRepository;
  /** 登记一份外部源文件,供 stageImport 读取。 */
  registerSource(path: string, bytes: Uint8Array): void;
  /** 构造一个返回固定路径集合(或 null 表示取消)的文件选择器。 */
  createPicker(paths: string[] | null): FilePicker;
}

/** TypeScript 批量导入契约:内存 Adapter 与 Tauri Adapter 必须通过同一组断言。 */
export function importBatchContract(harness: ImportBatchContractHarness): void {
  it('多选导入:多个 EPUB 分别成功并全部进入书库', async () => {
    const repository = harness.createRepository();
    harness.registerSource('a.epub', buildEpub({ title: '甲', author: '作者', language: 'zh' }));
    harness.registerSource('b.epub', buildEpub({ title: '乙', author: '作者', language: 'zh' }));
    const picker = harness.createPicker(['a.epub', 'b.epub']);

    const outcomes = await importBooks({ importRepository: repository, filePicker: picker });

    expect(outcomes).toHaveLength(2);
    expect(outcomes?.every((outcome) => outcome.kind === 'success')).toBe(true);
    const materials = await repository.listMaterials();
    expect(materials).toHaveLength(2);
    expect(materials.map((material) => material.title)).toEqual(['甲', '乙']);
  });

  it('取消选择返回 null 且不创建记录或暂存文件', async () => {
    const repository = harness.createRepository();
    const picker = harness.createPicker(null);

    const outcomes = await importBooks({ importRepository: repository, filePicker: picker });

    expect(outcomes).toBeNull();
    expect(await repository.listMaterials()).toHaveLength(0);
  });

  it('单个文件失败不掩盖其它成功文件,失败文件不留 ready 记录', async () => {
    const repository = harness.createRepository();
    harness.registerSource('good.epub', buildEpub({ title: '甲' }));
    harness.registerSource('bad.epub', new TextEncoder().encode('not-an-epub'));
    const picker = harness.createPicker(['good.epub', 'bad.epub']);

    const outcomes = (await importBooks({ importRepository: repository, filePicker: picker }))!;

    expect(outcomes).toHaveLength(2);
    const failed = outcomes.find((outcome) => outcome.kind === 'failure');
    expect(failed?.kind).toBe('failure');
    expect(failed?.fileName).toBe('bad.epub');
    expect(await repository.listMaterials()).toHaveLength(1);
  });

  it('空文件按 empty 分类并给出可行动的文案', async () => {
    const repository = harness.createRepository();
    harness.registerSource('empty.epub', new Uint8Array(0));
    const picker = harness.createPicker(['empty.epub']);

    const outcomes = (await importBooks({ importRepository: repository, filePicker: picker }))!;

    expect(outcomes[0]?.kind).toBe('failure');
    if (outcomes[0] && outcomes[0].kind === 'failure') {
      expect(outcomes[0].failure.kind).toBe('empty');
      expect(outcomes[0].failure.message).toMatch(/为空/);
    }
    expect(await repository.listMaterials()).toHaveLength(0);
  });

  it('相同内容的文件在同一批次中只保留一份', async () => {
    const repository = harness.createRepository();
    const bytes = buildEpub({ title: '甲' });
    harness.registerSource('a.epub', bytes);
    harness.registerSource('copy.epub', bytes);
    const picker = harness.createPicker(['a.epub', 'copy.epub']);

    const outcomes = (await importBooks({ importRepository: repository, filePicker: picker }))!;

    expect(outcomes?.every((outcome) => outcome.kind === 'success')).toBe(true);
    expect(await repository.listMaterials()).toHaveLength(1);
  });
}