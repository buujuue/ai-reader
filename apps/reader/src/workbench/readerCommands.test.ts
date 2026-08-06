import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_IDS, CommandRegistry } from '../commands/commandRegistry';
import { createInMemoryImportRepository, addInMemorySource } from '../domain/library/inMemoryImportRepository';
import { buildEpub } from '../domain/library/epub/zipWriter';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import type { FoliateViewHost } from '../domain/reader/viewHost';
import { mountViewDocument, registerReaderCommands } from './readerCommands';
import { useWorkspaceStore } from './workspaceStore';
import { useReaderRuntime } from './readerRuntime';

function createFakeViewHost(): FoliateViewHost {
  return {
    async open() {},
    async init() {},
    async next() {},
    async prev() {},
    async goToLocation() {},
    getCurrentCFI() {
      return null;
    },
    onRelocate() {
      return () => undefined;
    },
    onContentData() {
      return () => undefined;
    },
    close() {},
  };
}

describe('Reader 命令', () => {
  let registry: CommandRegistry;
  let importRepository: ReturnType<typeof createInMemoryImportRepository>;
  let workspaceRepository: ReturnType<typeof createInMemoryWorkspaceRepository>;

  async function setupWithEpub() {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, '演示书/示例书.epub', buildEpub({ title: '示例书' }));
    importRepository = createInMemoryImportRepository(sources);
    const staged = await importRepository.stageImport('演示书/示例书.epub');
    const bytes = await importRepository.readStagedFile(staged);
    const { inspectEpub } = await import('../domain/library/epub/epubInspector');
    const { metadata } = await inspectEpub(bytes);
    return importRepository.commitImport(staged, metadata);
  }

  beforeEach(() => {
    registry = new CommandRegistry();
    workspaceRepository = createInMemoryWorkspaceRepository();
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
  });

  it('打开书籍后新增标签并在运行时注册 BookDocument', async () => {
    const material = await setupWithEpub();
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);

    const group = useWorkspaceStore.getState().editorGroups[0]!;
    expect(group.views).toHaveLength(1);
    expect(group.views[0]!.materialId).toBe(material.id);
    expect(useReaderRuntime.getState().documents.has(group.views[0]!.id)).toBe(true);
  });

  it('翻页命令作用于活动视图的 BookDocument', async () => {
    const material = await setupWithEpub();
    const nextSpy = vi.fn();
    const host = { ...createFakeViewHost(), next: nextSpy };
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => host,
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const book = useReaderRuntime.getState().getDocument(viewId)!;
    useReaderRuntime.getState().removeDocument(viewId);
    await book.open(document.createElement('div'));
    useReaderRuntime.getState().setDocument(viewId, book);

    await registry.execute(COMMAND_IDS.readerNextPage);

    expect(nextSpy).toHaveBeenCalledTimes(1);
  });

  it('关闭视图会移除文档和标签', async () => {
    const material = await setupWithEpub();
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    await registry.execute(COMMAND_IDS.readerCloseView, viewId);

    expect(useReaderRuntime.getState().documents.has(viewId)).toBe(false);
    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(0);
  });
});