import { describe, expect, it } from 'vitest';

import { createInMemoryFilePicker, type FilePicker } from '../app/filePicker';
import { EpubInspectError } from '../domain/library/epub/epubInspector';
import { addInMemorySource, createInMemoryImportRepository } from '../domain/library/inMemoryImportRepository';
import { buildEpub } from '../domain/library/epub/zipWriter';
import { importOneBook } from './importBook';

function makeIo(overrides?: { sourcePath?: string; bytes?: Uint8Array }) {
  const sources = new Map<string, Uint8Array>();
  const sourcePath = overrides?.sourcePath ?? '书/exam.epub';
  const bytes = overrides?.bytes ?? buildEpub({ title: '示例书', author: '作者', language: 'zh' });
  addInMemorySource(sources, sourcePath, bytes);
  return {
    importRepository: createInMemoryImportRepository(sources),
    filePicker: createInMemoryFilePicker(sourcePath),
  };
}

describe('importOneBook 编排', () => {
  it('取消选择时返回 null 且不创建任何记录', async () => {
    const filePicker: FilePicker = { pickEpub: async () => null };
    const { importRepository } = makeIo();

    const result = await importOneBook({ importRepository, filePicker });

    expect(result).toBeNull();
    expect(await importRepository.listMaterials()).toHaveLength(0);
  });

  it('成功导入时提取来源元数据并提交为阅读材料', async () => {
    const io = makeIo();

    const material = await importOneBook(io);

    expect(material).not.toBeNull();
    expect(material?.title).toBe('示例书');
    expect(material?.author).toBe('作者');
    expect(material?.language).toBe('zh');
    expect(await io.importRepository.listMaterials()).toHaveLength(1);
  });

  it('损坏文件抛出领域化错误且不产生记录', async () => {
    const io = makeIo({ bytes: new TextEncoder().encode('not-an-epub') });

    await expect(importOneBook(io)).rejects.toBeInstanceOf(EpubInspectError);
    expect(await io.importRepository.listMaterials()).toHaveLength(0);
  });
});
