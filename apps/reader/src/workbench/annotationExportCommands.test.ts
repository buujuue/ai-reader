import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationExportDestinationPicker } from '../app/annotationExportDestinationPicker';
import { CommandRegistry, COMMAND_IDS } from '../commands/commandRegistry';
import type { Annotation } from '../domain/annotation/annotation';
import { createInMemoryAnnotationRepository } from '../domain/annotation/inMemoryAnnotationRepository';
import type { AnnotationExportWriter } from '../domain/annotation/annotationExportWriter';
import type { ReadingMaterial } from '../domain/library/material';
import { useLibraryStore } from './libraryStore';
import { useShellUiStore } from './shellUiStore';
import {
  registerAnnotationExportCommands,
  type AnnotationExportCommandDependencies,
} from './annotationExportCommands';

function makeMaterial(): ReadingMaterial {
  return {
    id: 'material-1',
    fingerprint: 'fingerprint-1',
    sourceFileName: 'book.epub',
    folderId: null,
    source: { title: '示例书', author: '来源作者', language: 'zh' },
    override: { title: null, author: null, coverSource: null },
    title: '示例书',
    author: '示例作者',
    language: 'zh',
    coverSource: null,
    documentVersion: 0,
  };
}

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'annotation-1',
    materialId: 'material-1',
    anchor: {
      cfi: 'epubcfi(/6/4)!/4/2/2/1:0',
      quote: '重要原文',
      before: '',
      after: '',
      documentVersion: 'fingerprint-1',
      recoveryState: 'resolved',
    },
    style: 'highlight',
    color: '#ffd54f',
    note: '读后笔记',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function setup(options: { destination?: string | null; writerError?: Error } = {}) {
  const annotationRepository = createInMemoryAnnotationRepository();
  vi.spyOn(annotationRepository, 'listByMaterial');
  const destinationPicker: AnnotationExportDestinationPicker = {
    pickAnnotationExportDestination: vi.fn(async () => options.destination ?? null),
  };
  const writer: AnnotationExportWriter = {
    writeMarkdown: vi.fn(async () => {
      if (options.writerError) throw options.writerError;
    }),
  };
  const dependencies: AnnotationExportCommandDependencies = {
    annotationRepository,
    destinationPicker,
    writer,
  };
  const registry = new CommandRegistry();
  registerAnnotationExportCommands(registry, dependencies);
  useLibraryStore.setState({ materials: [makeMaterial()] });
  useShellUiStore.getState().clearStatusMessage();
  return { registry, annotationRepository, destinationPicker, writer };
}

describe('annotation.exportMarkdown command', () => {
  beforeEach(() => {
    useLibraryStore.getState().resetToDefault();
    useShellUiStore.getState().clearStatusMessage();
  });

  it('取消目标选择时不读取批注也不写文件', async () => {
    const harness = setup({ destination: null });

    const result = await harness.registry.execute(
      COMMAND_IDS.annotationExportMarkdown,
      'material-1',
    );

    expect(result).toBeNull();
    expect(harness.annotationRepository.listByMaterial).not.toHaveBeenCalled();
    expect(harness.writer.writeMarkdown).not.toHaveBeenCalled();
    expect(useShellUiStore.getState().statusMessage).toBe('已取消批注 Markdown 导出');
  });

  it('读取材料级批注并写出包含失联批注的 Markdown', async () => {
    const harness = setup({ destination: 'C:/notes/示例书-批注.md' });
    await harness.annotationRepository.saveAnnotation(makeAnnotation());
    await harness.annotationRepository.saveAnnotation(
      makeAnnotation({
        id: 'annotation-2',
        anchor: { ...makeAnnotation().anchor, recoveryState: 'orphaned' },
      }),
    );

    const result = await harness.registry.execute(
      COMMAND_IDS.annotationExportMarkdown,
      'material-1',
    );

    expect(result).toEqual({
      destinationPath: 'C:/notes/示例书-批注.md',
      annotationCount: 2,
    });
    expect(harness.writer.writeMarkdown).toHaveBeenCalledOnce();
    expect(harness.writer.writeMarkdown).toHaveBeenCalledWith(
      'C:/notes/示例书-批注.md',
      expect.stringContaining('状态：失联批注'),
    );
    expect(useShellUiStore.getState().statusMessage).toBe('批注 Markdown 已导出，共 2 条');
  });

  it('写入失败时报告失败并向调用方传播错误', async () => {
    const error = new Error('磁盘空间不足');
    const harness = setup({ destination: 'notes.md', writerError: error });
    await harness.annotationRepository.saveAnnotation(makeAnnotation());

    await expect(
      harness.registry.execute(COMMAND_IDS.annotationExportMarkdown, 'material-1'),
    ).rejects.toBe(error);
    expect(useShellUiStore.getState().statusMessage).toBe(
      '批注 Markdown 导出失败，未生成可用文件',
    );
  });
});
