import { describe, expect, it } from 'vitest';

import { createInMemoryFilePicker, type FilePicker } from '../app/filePicker';
import {
  addInMemorySource,
  createInMemoryImportRepository,
} from '../domain/library/inMemoryImportRepository';
import type { ImportRepository } from '../domain/library/importRepository';
import type { StagedImport } from '../domain/library/material';
import { buildEpub } from '../domain/library/epub/zipWriter';
import { importBooks, classifyImportError } from './importBook';

function makeIo(overrides?: { sourcePaths?: string[]; bytes?: Record<string, Uint8Array> }) {
  const sources = new Map<string, Uint8Array>();
  const sourcePaths = overrides?.sourcePaths ?? ['书/示例书.epub'];
  const bytes = overrides?.bytes ?? {
    '书/示例书.epub': buildEpub({ title: '示例书', author: '作者', language: 'zh' }),
  };
  for (const [path, content] of Object.entries(bytes)) {
    addInMemorySource(sources, path, content);
  }
  return {
    importRepository: createInMemoryImportRepository(sources),
    filePicker: createInMemoryFilePicker(sourcePaths),
  };
}

describe('importBooks 批量编排', () => {
  it('取消选择时返回 null 且不创建任何记录', async () => {
    const filePicker: FilePicker = {
      pickBooks: async () => null,
      pickImage: async () => null,
    };
    const { importRepository } = makeIo();

    const result = await importBooks({ importRepository, filePicker });

    expect(result).toBeNull();
    expect(await importRepository.listMaterials()).toHaveLength(0);
  });

  it('多份 EPUB 分别成功导入并全部进入书库', async () => {
    const io = makeIo({
      sourcePaths: ['a.epub', 'b.epub'],
      bytes: {
        'a.epub': buildEpub({ title: '甲', author: '作者', language: 'zh' }),
        'b.epub': buildEpub({ title: '乙', author: '作者', language: 'zh' }),
      },
    });

    const outcomes = (await importBooks(io))!;

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.kind === 'success')).toBe(true);
    expect((await io.importRepository.listMaterials()).map((m) => m.title)).toEqual(['甲', '乙']);
  });

  it('单个损坏文件失败不影响其它成功文件,且失败文件不留记录', async () => {
    const io = makeIo({
      sourcePaths: ['good.epub', 'bad.epub'],
      bytes: {
        'good.epub': buildEpub({ title: '甲' }),
        'bad.epub': new TextEncoder().encode('not-an-epub'),
      },
    });

    const outcomes = (await importBooks(io))!;

    const failed = outcomes.find((outcome) => outcome.kind === 'failure');
    expect(failed?.kind).toBe('failure');
    expect(failed?.fileName).toBe('bad.epub');
    expect((await io.importRepository.listMaterials()).map((m) => m.title)).toEqual(['甲']);
  });

  it('失败文件即使被丢弃后也能继续导入后续文件', async () => {
    const io = makeIo({
      sourcePaths: ['bad.epub', 'good.epub'],
      bytes: {
        'bad.epub': new Uint8Array(0),
        'good.epub': buildEpub({ title: '甲' }),
      },
    });

    const outcomes = (await importBooks(io))!;

    expect(outcomes[0]?.kind).toBe('failure');
    expect(outcomes[1]?.kind).toBe('success');
    expect(await io.importRepository.listMaterials()).toHaveLength(1);
  });
});

describe('classifyImportError', () => {
  it('空文件归类为 empty', () => {
    const failure = classifyImportError(new Error('文件内容为空,无法导入'));

    expect(failure.kind).toBe('empty');
    expect(failure.message).toMatch(/为空/);
  });

  it('权限拒绝归类为 permission', () => {
    const failure = classifyImportError(new Error('没有权限读取该文件:拒绝访问'));

    expect(failure.kind).toBe('permission');
    expect(failure.message).toMatch(/权限/);
  });

  it('空间不足归类为 space', () => {
    const failure = classifyImportError(new Error('磁盘空间不足:ENOSPC'));

    expect(failure.kind).toBe('space');
    expect(failure.message).toMatch(/空间/);
  });

  it('未知错误归类为 other', () => {
    const failure = classifyImportError(new Error('something unexpected'));

    expect(failure.kind).toBe('other');
  });
});

describe('importBooks 对仓库 IO 失败的处理', () => {
  it('暂存失败(如无权限)记为 permission 失败且不中断其它文件', async () => {
    const goodSource = 'good.epub';
    const badSource = 'denied.epub';
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, goodSource, buildEpub({ title: '甲' }));
    const repository: ImportRepository = createInMemoryImportRepository(sources);
    const originalStage = repository.stageImport.bind(repository);
    repository.stageImport = async (sourcePath) => {
      if (sourcePath === badSource) {
        throw new Error('没有权限读取文件:PermissionDenied');
      }
      return originalStage(sourcePath);
    };
    const filePicker: FilePicker = {
      pickBooks: async () => [badSource, goodSource],
      pickImage: async () => null,
    };

    const outcomes = (await importBooks({ importRepository: repository, filePicker }))!;

    const failed = outcomes.find((outcome) => outcome.kind === 'failure');
    expect(failed?.kind).toBe('failure');
    if (failed && failed.kind === 'failure') {
      expect(failed.failure.kind).toBe('permission');
    }
    expect((await repository.listMaterials()).map((m) => m.title)).toEqual(['甲']);
  });

  it('提交失败(如空间不足)记为 space 失败且失败文件不留 ready 记录', async () => {
    const sourcePath = 'big.epub';
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, sourcePath, buildEpub({ title: '甲' }));
    const repository: ImportRepository = createInMemoryImportRepository(sources);
    const originalCommit = repository.commitImport.bind(repository);
    let stagedHandle: StagedImport | null = null;
    repository.commitImport = async (staged, metadata) => {
      stagedHandle = staged;
      throw new Error('磁盘空间不足:WriteZero');
    };
    const filePicker: FilePicker = {
      pickBooks: async () => [sourcePath],
      pickImage: async () => null,
    };

    const outcomes = (await importBooks({ importRepository: repository, filePicker }))!;

    const failed = outcomes[0];
    expect(failed?.kind).toBe('failure');
    if (failed && failed.kind === 'failure') {
      expect(failed.failure.kind).toBe('space');
    }
    expect(await repository.listMaterials()).toHaveLength(0);
    expect(stagedHandle).not.toBeNull();
  });
});