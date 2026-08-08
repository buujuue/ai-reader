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
    async goToHref() {},
    getTOC() {
      return [];
    },
    getCurrentCFI() {
      return null;
    },
    onRelocate() {
      return () => undefined;
    },
    onInternalLink() {
      return () => undefined;
    },
    onExternalLink() {
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

describe('Reader 导航命令', () => {
  let registry: CommandRegistry;
  let importRepository: ReturnType<typeof createInMemoryImportRepository>;
  let workspaceRepository: ReturnType<typeof createInMemoryWorkspaceRepository>;

  function createNavigableFakeHost() {
    const relocateListeners: Array<(cfi: string) => void> = [];
    const internalLinkListeners: Array<(href: string) => void> = [];
    const externalLinkListeners: Array<(href: string) => void> = [];
    const host = {
      ...createFakeViewHost(),
      open: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      goToHref: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      goToLocation: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      onRelocate: (listener: (cfi: string) => void) => {
        relocateListeners.push(listener);
        return () => {
          const index = relocateListeners.indexOf(listener);
          if (index >= 0) relocateListeners.splice(index, 1);
        };
      },
      onInternalLink: (listener: (href: string) => void) => {
        internalLinkListeners.push(listener);
        return () => {
          const index = internalLinkListeners.indexOf(listener);
          if (index >= 0) internalLinkListeners.splice(index, 1);
        };
      },
      onExternalLink: (listener: (href: string) => void) => {
        externalLinkListeners.push(listener);
        return () => {
          const index = externalLinkListeners.indexOf(listener);
          if (index >= 0) externalLinkListeners.splice(index, 1);
        };
      },
      emitRelocate: (cfi: string) => {
        for (const listener of relocateListeners) listener(cfi);
      },
      emitInternalLink: (href: string) => {
        for (const listener of internalLinkListeners) listener(href);
      },
      emitExternalLink: (href: string) => {
        for (const listener of externalLinkListeners) listener(href);
      },
    };
    return host;
  }

  async function setupWithHost(host: ReturnType<typeof createNavigableFakeHost>) {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, '演示书/示例书.epub', buildEpub({ title: '示例书' }));
    importRepository = createInMemoryImportRepository(sources);
    const staged = await importRepository.stageImport('演示书/示例书.epub');
    const bytes = await importRepository.readStagedFile(staged);
    const { inspectEpub } = await import('../domain/library/epub/epubInspector');
    const { metadata } = await inspectEpub(bytes);
    const material = await importRepository.commitImport(staged, metadata);
    workspaceRepository = createInMemoryWorkspaceRepository();
    registry = new CommandRegistry();
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => host,
    });
    await registry.execute(COMMAND_IDS.libraryOpenBook, material);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const book = useReaderRuntime.getState().getDocument(viewId)!;
    const container = globalThis.document.createElement('div');
    mountViewDocument(book, viewId, container, null, {
      importRepository,
      workspaceRepository,
    });
    // mountViewDocument 内部异步 open,等待其完成后再执行导航命令。
    await vi.waitFor(() => expect(host.open).toHaveBeenCalled());
    return material;
  }

  beforeEach(() => {
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
  });

  it('目录跳转命令把目标 href 交给 BookDocument 并压入历史节点', async () => {
    const host = createNavigableFakeHost();
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    await registry.execute(COMMAND_IDS.readerGoToHref, viewId, 'chapter2.xhtml');

    expect(host.goToHref).toHaveBeenCalledWith('chapter2.xhtml');
  });

  it('后退命令移动到前一个历史位置', async () => {
    const host = createNavigableFakeHost();
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/1)' });
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/2)' });
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/3)' });

    await registry.execute(COMMAND_IDS.readerBack, viewId);

    const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
    expect(view.history.index).toBe(1);
    expect(view.location).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/2)' });
    expect(host.goToLocation).toHaveBeenCalledWith('epubcfi(/6/2)');
  });

  it('后退后前进命令回到更靠后的历史位置', async () => {
    const host = createNavigableFakeHost();
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/1)' });
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/2)' });
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/3)' });
    await registry.execute(COMMAND_IDS.readerBack, viewId);
    await registry.execute(COMMAND_IDS.readerForward, viewId);

    const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
    expect(view.history.index).toBe(2);
    expect(view.location).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/3)' });
  });

  it('在最早位置后退命令不改变历史', async () => {
    const host = createNavigableFakeHost();
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/1)' });

    await registry.execute(COMMAND_IDS.readerBack, viewId);

    const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
    expect(view.history.index).toBe(0);
    expect(view.location).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/1)' });
  });

  it('书内链接事件触发往同一视图的显式跳转', async () => {
    const host = createNavigableFakeHost();
    await setupWithHost(host);

    host.emitInternalLink('chapter2.xhtml');
    await vi.waitFor(() => expect(host.goToHref).toHaveBeenCalledWith('chapter2.xhtml'));
  });
});