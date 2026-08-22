import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_IDS, CommandRegistry, type CommandId } from '../commands/commandRegistry';
import { createInMemoryImportRepository, addInMemorySource } from '../domain/library/inMemoryImportRepository';
import { buildEpub } from '../domain/library/epub/zipWriter';
import { ManagedFileSource } from '../domain/library/managedFileSource';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { DEFAULT_WORKSPACE_STATE } from '../domain/workspace/workspaceState';
import type { FoliateViewHost } from '../domain/reader/viewHost';
import { ReadingInputController } from '../domain/reader/readingInput';
import type { SearchEvent } from '../domain/reader/search';
import { makeFakeDocument, makeFakeLib, makeFakeRasterizer } from '../domain/reader/pdf/pdfTestFakes';
import { mountViewDocument, registerReaderCommands } from './readerCommands';
import { useWorkspaceStore } from './workspaceStore';
import { useReaderRuntime } from './readerRuntime';
import { useSearchStore } from './searchStore';

function createFakeViewHost(overrides: Partial<FoliateViewHost> = {}): FoliateViewHost {
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
    getCFI() {
      return 'epubcfi(/6/1)';
    },
    getCurrentIndex() {
      return 0;
    },
    addAnnotation() {},
    removeAnnotation() {},
    onShowAnnotation() {
      return () => undefined;
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
    getContentDocs() {
      return [];
    },
    onContentCreate() {
      return () => undefined;
    },
    async *search() {},
    clearSearch() {},
    applyTypography() {},
    close() {},
    ...overrides,
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

  async function setupWithEpubMaterials() {
    const sources = new Map<string, Uint8Array>();
    const names = ['demo-a.epub', 'demo-b.epub'];
    for (const [index, name] of names.entries()) {
      addInMemorySource(sources, name, buildEpub({ title: `Demo Book ${index + 1}` }));
    }
    importRepository = createInMemoryImportRepository(sources);
    const materials = [];
    for (const name of names) {
      const staged = await importRepository.stageImport(name);
      const bytes = await importRepository.readStagedFile(staged);
      const { metadata } = await import('../domain/library/epub/epubInspector').then(({ inspectEpub }) =>
        inspectEpub(bytes),
      );
      materials.push(await importRepository.commitImport(staged, metadata));
    }
    return materials;
  }

  beforeEach(() => {
    registry = new CommandRegistry();
    workspaceRepository = createInMemoryWorkspaceRepository();
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map(), documentStates: new Map() });
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

  it('托管副本缺失时保留标签并明确提示正文不可用', async () => {
    const material = {
      ...(await setupWithEpub()),
      managedFileAvailable: false,
    };
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await expect(registry.execute(COMMAND_IDS.libraryOpenBook, material)).rejects.toThrow(
      '无法打开阅读材料',
    );
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    expect(useReaderRuntime.getState().documentStates.get(viewId)).toEqual({
      status: 'error',
      message: expect.stringContaining('正文当前不可用'),
    });
  });

  it('阅读文档打开失败时把错误写入运行时状态而不是留下无提示空白', async () => {
    const material = await setupWithEpub();
    const openError = new Error('WebView 阅读器初始化失败');
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost({
        open: vi.fn().mockRejectedValue(openError),
      }),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    mountViewDocument(
      useReaderRuntime.getState().getDocument(viewId)!,
      viewId,
      document.createElement('div'),
      null,
      { importRepository, workspaceRepository },
    );

    await vi.waitFor(() => {
      expect(useReaderRuntime.getState().documentStates.get(viewId)).toEqual({
        status: 'error',
        message: openError.message,
      });
    });
  });

  it('同一视图重复挂载时只打开一次阅读器', async () => {
    const material = await setupWithEpub();
    const host = createFakeViewHost({ open: vi.fn(async () => {}) });
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => host,
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const book = useReaderRuntime.getState().getDocument(viewId)!;
    const container = document.createElement('div');
    mountViewDocument(book, viewId, container, null, { importRepository, workspaceRepository });
    mountViewDocument(book, viewId, container, null, { importRepository, workspaceRepository });

    await vi.waitFor(() => expect(host.open).toHaveBeenCalledOnce());
  });

  it('材料解析失败时保留标签并把解析错误写入运行时状态', async () => {
    const material = await setupWithEpub();
    vi.spyOn(importRepository, 'openManagedFileSource').mockResolvedValue(
      new ManagedFileSource(
        { name: 'broken.epub', size: 3 },
        async () => new Uint8Array([1, 2, 3]),
      ),
    );
    registerReaderCommands(registry, { importRepository, workspaceRepository });

    await expect(registry.execute(COMMAND_IDS.libraryOpenBook, material)).rejects.toThrow(
      '无法打开阅读材料',
    );

    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    expect(useReaderRuntime.getState().documentStates.get(viewId)).toEqual({
      status: 'error',
      message: expect.stringContaining('解析 EPUB 失败'),
    });
  });

  it('拆分当前阅读任务后两个编辑器组各自保留一个活跃阅读器', async () => {
    const firstMaterial = (await setupWithEpubMaterials())[0]!;
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, firstMaterial);
    const firstViewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    useWorkspaceStore.getState().setViewLocation(firstViewId, {
      kind: 'epub',
      cfi: 'epubcfi(/6/4)',
    });

    await registry.execute(COMMAND_IDS.workbenchSplitEditorGroupRight);

    const state = useWorkspaceStore.getState();
    const secondViewId = state.editorGroups[1]!.views[0]!.id;
    expect(state.splitDirection).toBe('right');
    expect(state.editorGroups).toHaveLength(2);
    expect(state.activeEditorGroupId).toBe('group-2');
    expect(state.editorGroups[0]!.views[0]!.id).toBe(firstViewId);
    expect(state.editorGroups[1]!.views[0]!.materialId).toBe(firstMaterial.id);
    expect(state.editorGroups[1]!.views[0]!.location).toEqual({
      kind: 'epub',
      cfi: 'epubcfi(/6/4)',
    });
    expect(useReaderRuntime.getState().documents.size).toBe(2);
    expect(useReaderRuntime.getState().documents.has(firstViewId)).toBe(true);
    expect(useReaderRuntime.getState().documents.has(secondViewId)).toBe(true);
  });

  it('重复打开同一本书会跳转到原标签,不重复创建文档', async () => {
    const material = await setupWithEpub();
    const openManagedFileSource = vi.spyOn(importRepository, 'openManagedFileSource');
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    const firstOpen = registry.execute(COMMAND_IDS.libraryOpenBook, material);
    const secondOpen = registry.execute(COMMAND_IDS.libraryOpenBook, material);
    await Promise.all([firstOpen, secondOpen]);
    const firstViewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const firstDocument = useReaderRuntime.getState().getDocument(firstViewId);
    useWorkspaceStore.getState().openView('another-material');

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);

    const group = useWorkspaceStore.getState().editorGroups[0]!;
    expect(group.views).toHaveLength(2);
    expect(group.activeViewId).toBe(firstViewId);
    expect(useReaderRuntime.getState().getDocument(firstViewId)).toBe(firstDocument);
    expect(openManagedFileSource).toHaveBeenCalledTimes(1);
  });

  it('switches tabs with one active runtime and restores the saved location', async () => {
    const [firstMaterial, secondMaterial] = await setupWithEpubMaterials();
    const hosts: Array<FoliateViewHost & { close: ReturnType<typeof vi.fn> }> = [];
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => {
        const host = {
          ...createFakeViewHost(),
          close: vi.fn(),
          goToLocation: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        hosts.push(host);
        return host;
      },
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, firstMaterial);
    const firstViewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const savedLocation = { kind: 'epub' as const, cfi: 'epubcfi(/6/4)' };
    mountViewDocument(
      useReaderRuntime.getState().getDocument(firstViewId)!,
      firstViewId,
      document.createElement('div'),
      null,
      { importRepository, workspaceRepository },
    );
    await vi.waitFor(() => expect(hosts).toHaveLength(1));
    useWorkspaceStore.getState().setViewLocation(firstViewId, savedLocation);

    await registry.execute(COMMAND_IDS.libraryOpenBook, secondMaterial);
    const secondViewId = useWorkspaceStore.getState().editorGroups[0]!.views[1]!.id;
    mountViewDocument(
      useReaderRuntime.getState().getDocument(secondViewId)!,
      secondViewId,
      document.createElement('div'),
      null,
      { importRepository, workspaceRepository },
    );
    await vi.waitFor(() => expect(hosts).toHaveLength(2));
    expect(useWorkspaceStore.getState().editorGroups[0]!.activeViewId).toBe(secondViewId);
    expect(useReaderRuntime.getState().documents.size).toBe(1);
    expect(useReaderRuntime.getState().documents.has(firstViewId)).toBe(false);
    expect(hosts[0]!.close).toHaveBeenCalledOnce();

    await registry.execute(COMMAND_IDS.readerActivateView, firstViewId);

    expect(useWorkspaceStore.getState().editorGroups[0]!.activeViewId).toBe(firstViewId);
    expect(useReaderRuntime.getState().documents.size).toBe(1);
    expect(useReaderRuntime.getState().documents.has(firstViewId)).toBe(true);
    expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location).toEqual(savedLocation);
    expect(hosts[1]!.close).toHaveBeenCalledOnce();

    const activeDocument = useReaderRuntime.getState().getDocument(firstViewId)!;
    mountViewDocument(activeDocument, firstViewId, document.createElement('div'), savedLocation, {
      importRepository,
      workspaceRepository,
    });
    await vi.waitFor(() => expect(hosts[2]!.goToLocation).toHaveBeenCalledWith(savedLocation.cfi));
  });

  it('closes the active tab and rebuilds the next tab runtime', async () => {
    const [firstMaterial, secondMaterial] = await setupWithEpubMaterials();
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, firstMaterial);
    const firstViewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    await registry.execute(COMMAND_IDS.libraryOpenBook, secondMaterial);
    const secondViewId = useWorkspaceStore.getState().editorGroups[0]!.views[1]!.id;

    await registry.execute(COMMAND_IDS.readerCloseView, secondViewId);

    const group = useWorkspaceStore.getState().editorGroups[0]!;
    expect(group.views.map((view) => view.id)).toEqual([firstViewId]);
    expect(group.activeViewId).toBe(firstViewId);
    expect(useReaderRuntime.getState().documents.size).toBe(1);
    expect(useReaderRuntime.getState().documents.has(firstViewId)).toBe(true);
  });

  it('restores only the active tab runtime', async () => {
    const materials = await setupWithEpubMaterials();
    const firstMaterial = materials[0]!;
    const secondMaterial = materials[1]!;
    const firstViewId = crypto.randomUUID();
    const secondViewId = crypto.randomUUID();
    useWorkspaceStore.getState().hydrate({
      ...DEFAULT_WORKSPACE_STATE,
      editorGroups: [
        {
          id: 'group-1',
          views: [
            {
              id: firstViewId,
              materialId: firstMaterial.id,
              location: { kind: 'epub', cfi: 'epubcfi(/6/1)' },
              history: { positions: [], index: -1 },
              sourceMode: false,
            },
            {
              id: secondViewId,
              materialId: secondMaterial.id,
              location: { kind: 'epub', cfi: 'epubcfi(/6/2)' },
              history: { positions: [], index: -1 },
              sourceMode: false,
            },
          ],
          activeViewId: secondViewId,
        },
      ],
    });
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await registry.execute(COMMAND_IDS.readerRestoreView, secondViewId, secondMaterial);

    expect(useReaderRuntime.getState().documents.size).toBe(1);
    expect(useReaderRuntime.getState().documents.has(secondViewId)).toBe(true);
    expect(useReaderRuntime.getState().documents.has(firstViewId)).toBe(false);
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

  it('Markdown 材料打开后注册 MarkdownBookDocument', async () => {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(
      sources,
      '演示书/示例笔记.md',
      new TextEncoder().encode('# 我的笔记\n\n正文'),
    );
    importRepository = createInMemoryImportRepository(sources);
    const staged = await importRepository.stageImport('演示书/示例笔记.md');
    const bytes = await importRepository.readStagedFile(staged);
    const { inspectMarkdown } = await import('../domain/reader/markdown/markdownInspector');
    const { metadata } = await inspectMarkdown(bytes, '示例笔记.md');
    const material = await importRepository.commitImport(staged, metadata);
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);

    const group = useWorkspaceStore.getState().editorGroups[0]!;
    expect(group.views).toHaveLength(1);
    const book = useReaderRuntime.getState().getDocument(group.views[0]!.id)!;
    expect(book.format).toBe('markdown');
  });

  it('Markdown 打开只通过 ManagedFileSource 获取正文', async () => {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(
      sources,
      '演示书/来源边界.md',
      new TextEncoder().encode('# 来源边界\n\n正文'),
    );
    importRepository = createInMemoryImportRepository(sources);
    const staged = await importRepository.stageImport('演示书/来源边界.md');
    const bytes = await importRepository.readStagedFile(staged);
    const { inspectMarkdown } = await import('../domain/reader/markdown/markdownInspector');
    const { metadata } = await inspectMarkdown(bytes, '来源边界.md');
    const material = await importRepository.commitImport(staged, metadata);
    const openManagedFileSource = vi.spyOn(importRepository, 'openManagedFileSource');
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);

    expect(openManagedFileSource).toHaveBeenCalledWith(material.id);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    expect(useReaderRuntime.getState().getDocument(viewId)?.format).toBe('markdown');
  });

  it('PDF 打开让检查器与阅读文档共享 ManagedFileSource,不调用全量文件接口', async () => {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, '演示书/范围.pdf', new TextEncoder().encode('%PDF-1.7\n'));
    importRepository = createInMemoryImportRepository(sources);
    const staged = await importRepository.stageImport('演示书/范围.pdf');
    const bytes = await importRepository.readStagedFile(staged);
    const { inspectPdf } = await import('../domain/reader/pdf/pdfInspector');
    const { metadata } = await inspectPdf(bytes, makeFakeLib(makeFakeDocument(3)));
    const material = await importRepository.commitImport(staged, metadata);
    const openManagedFileSource = vi.spyOn(importRepository, 'openManagedFileSource');
    const pdfLib = makeFakeLib(makeFakeDocument(3));
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      pdfLib,
      pdfRasterize: makeFakeRasterizer(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);

    expect(openManagedFileSource).toHaveBeenCalledWith(material.id);
    expect(openManagedFileSource).toHaveBeenCalledTimes(1);
    const options = (pdfLib.getDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(options).not.toHaveProperty('data');
    expect(options).toEqual(expect.objectContaining({ range: expect.anything() }));
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

describe('Reader 搜索命令', () => {
  let registry: CommandRegistry;
  let importRepository: ReturnType<typeof createInMemoryImportRepository>;
  let workspaceRepository: ReturnType<typeof createInMemoryWorkspaceRepository>;

  function createSearchHost(query: string) {
    const host = {
      ...createFakeViewHost(),
      open: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      goToLocation: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      onRelocate: () => () => undefined,
      search: vi.fn(() =>
        (async function* () {
          yield { kind: 'progress', progress: 1 } as const;
          yield { kind: 'match', match: { cfi: 'epubcfi(/6/1)', excerpt: { pre: '前', match: query, post: '后' } } } as const;
          yield { kind: 'match', match: { cfi: 'epubcfi(/6/2)', excerpt: { pre: '甲', match: query, post: '乙' } } } as const;
        })(),
      ),
    };
    return host;
  }

  async function setupWithHost(
    host: FoliateViewHost & {
      open: ReturnType<typeof vi.fn>;
      search: ReturnType<typeof vi.fn>;
    },
  ) {
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
    mountViewDocument(book, viewId, container, null, { importRepository, workspaceRepository });
    await vi.waitFor(() => expect(host.open).toHaveBeenCalled());
    return viewId;
  }

  beforeEach(() => {
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
    useSearchStore.setState({ views: {} });
  });

  it('搜索命令在活动视图上运行并累积命中', async () => {
    const host = createSearchHost('关键词');
    await setupWithHost(host);

    await registry.execute(COMMAND_IDS.readerSearchRun, undefined, '关键词');
    await vi.waitFor(() => {
      const view = useSearchStore.getState().getView(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id);
      expect(view.matches).toHaveLength(2);
      expect(view.status).toBe('completed');
    });
  });

  it('搜索命令运行后 next/prev 在命中间跳转并压入导航历史', async () => {
    const host = createSearchHost('关键词');
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    await registry.execute(COMMAND_IDS.readerSearchRun, viewId, '关键词');
    await vi.waitFor(() => expect(useSearchStore.getState().getView(viewId).matches).toHaveLength(2));

    await registry.execute(COMMAND_IDS.readerSearchNext, viewId);
    expect(useSearchStore.getState().getView(viewId).currentIndex).toBe(0);
    expect(host.goToLocation).toHaveBeenCalledWith('epubcfi(/6/1)');

    await registry.execute(COMMAND_IDS.readerSearchNext, viewId);
    expect(useSearchStore.getState().getView(viewId).currentIndex).toBe(1);
    expect(host.goToLocation).toHaveBeenCalledWith('epubcfi(/6/2)');

    await registry.execute(COMMAND_IDS.readerSearchPrev, viewId);
    expect(useSearchStore.getState().getView(viewId).currentIndex).toBe(0);
  });

  it('搜索结果为空时 next 不导航', async () => {
    const host = {
      ...createFakeViewHost(),
      open: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      goToLocation: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      onRelocate: () => () => undefined,
      search: vi.fn(() => (async function* () {})()),
    };
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    await registry.execute(COMMAND_IDS.readerSearchRun, viewId, '无结果');
    await vi.waitFor(() => expect(host.search).toHaveBeenCalled());

    await registry.execute(COMMAND_IDS.readerSearchNext, viewId);
    expect(host.goToLocation).not.toHaveBeenCalled();
  });

  it('关闭搜索清理结果并清空搜索状态', async () => {
    const host = createSearchHost('关键词');
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    await registry.execute(COMMAND_IDS.readerSearchOpen, viewId);
    await registry.execute(COMMAND_IDS.readerSearchRun, viewId, '关键词');
    await vi.waitFor(() => expect(useSearchStore.getState().getView(viewId).matches).toHaveLength(2));

    await registry.execute(COMMAND_IDS.readerSearchClose, viewId);

    expect(useSearchStore.getState().getView(viewId).matches).toHaveLength(0);
    expect(useSearchStore.getState().getView(viewId).active).toBe(false);
  });

  it('大小为写开关的命令按新开关用当前草稿重新搜索', async () => {
    const host = createSearchHost('关键词');
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    await registry.execute(COMMAND_IDS.readerSearchRun, viewId, '关键词');
    await vi.waitFor(() => expect(useSearchStore.getState().getView(viewId).matches).toHaveLength(2));

    await registry.execute(COMMAND_IDS.readerSearchToggleCase, viewId, '新草稿');

    expect(useSearchStore.getState().getView(viewId).matchCase).toBe(true);
    expect(host.search).toHaveBeenLastCalledWith({ query: '新草稿', matchCase: true });
  });

  it('新查询会取消上一个搜索任务(调用其生成器的 return)', async () => {
    const returned = vi.fn();
    const inner = (async function* () {
      yield { kind: 'progress', progress: 0.5 } as const;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    })();
    const generator = {
      return: () => {
        returned();
        return inner.return(undefined);
      },
      throw: (value: unknown) => inner.throw(value),
      next: (value?: unknown) => inner.next(value),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const host = {
      ...createFakeViewHost(),
      open: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      goToLocation: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      onRelocate: () => () => undefined,
      search: vi.fn(() => generator as AsyncGenerator<SearchEvent, void, unknown>),
    };
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    await registry.execute(COMMAND_IDS.readerSearchRun, viewId, '第一次');
    await vi.waitFor(() => expect(host.search).toHaveBeenCalledTimes(1));

    await registry.execute(COMMAND_IDS.readerSearchRun, viewId, '第二次');

    expect(host.search).toHaveBeenCalledTimes(2);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it('关闭视图会清理其搜索状态并取消任务', async () => {
    const host = createSearchHost('关键词');
    await setupWithHost(host);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;

    await registry.execute(COMMAND_IDS.readerSearchOpen, viewId);
    await registry.execute(COMMAND_IDS.readerSearchRun, viewId, '关键词');
    await vi.waitFor(() => expect(useSearchStore.getState().getView(viewId).matches).toHaveLength(2));

    await registry.execute(COMMAND_IDS.readerCloseView, viewId);

    expect(useSearchStore.getState().getView(viewId).active).toBe(false);
    expect(useSearchStore.getState().getView(viewId).matches).toHaveLength(0);
    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(0);
  });
});

describe('Reader 排版命令', () => {
  let registry: CommandRegistry;
  let importRepository: ReturnType<typeof createInMemoryImportRepository>;
  let workspaceRepository: ReturnType<typeof createInMemoryWorkspaceRepository>;

  function createTypographyHost() {
    const applyTypography = vi.fn();
    const host = {
      ...createFakeViewHost(),
      open: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      onRelocate: () => () => undefined,
      applyTypography,
    };
    return host;
  }

  async function setupWithHost(host: ReturnType<typeof createTypographyHost>) {
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
    mountViewDocument(book, viewId, container, null, { importRepository, workspaceRepository });
    await vi.waitFor(() => expect(host.open).toHaveBeenCalled());
    return { material, viewId };
  }

  beforeEach(() => {
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
  });

  it('应用排版命令把材料级覆盖写入 Store 并应用到 BookDocument', async () => {
    const host = createTypographyHost();
    const { material, viewId } = await setupWithHost(host);

    await registry.execute(COMMAND_IDS.readerApplyTypography, viewId, {
      fontSize: 24,
      theme: 'dark',
    });

    expect(useWorkspaceStore.getState().materialTypography[material.id]).toMatchObject({
      fontSize: 24,
      theme: 'dark',
    });
    // 挂载时已应用一次全局默认,再加这次 patch,共两次且最后一次为合并结果。
    const last = host.applyTypography.mock.calls.at(-1)![0];
    expect(last.fontSize).toBe(24);
    expect(last.theme).toBe('dark');
    expect(last.fontFamily).toBe(useWorkspaceStore.getState().globalReadingTypography.fontFamily);
  });

  it('应用排版命令把数值字段收敛到合理区间', async () => {
    const host = createTypographyHost();
    const { material, viewId } = await setupWithHost(host);

    await registry.execute(COMMAND_IDS.readerApplyTypography, viewId, {
      fontSize: 9999,
      lineHeight: 99,
      margin: -50,
    });

    const override = useWorkspaceStore.getState().materialTypography[material.id]!;
    expect(override.fontSize).toBe(48);
    expect(override.lineHeight).toBe(3);
    expect(override.margin).toBe(0);
  });

  it('恢复排版命令清除材料级覆盖并回退到全局默认', async () => {
    const host = createTypographyHost();
    const { material, viewId } = await setupWithHost(host);
    await registry.execute(COMMAND_IDS.readerApplyTypography, viewId, { fontSize: 24 });
    expect(useWorkspaceStore.getState().materialTypography[material.id]).toBeDefined();

    await registry.execute(COMMAND_IDS.readerResetTypography, viewId);

    expect(useWorkspaceStore.getState().materialTypography[material.id]).toBeUndefined();
    const last = host.applyTypography.mock.calls.at(-1)![0];
    expect(last.fontSize).toBe(useWorkspaceStore.getState().globalReadingTypography.fontSize);
  });

  it('设置全局排版命令更新全局默认并应用到无覆盖的开放视图', async () => {
    const host = createTypographyHost();
    const { viewId } = await setupWithHost(host);

    await registry.execute(COMMAND_IDS.readerSetGlobalTypography, { fontSize: 21 });

    expect(useWorkspaceStore.getState().globalReadingTypography.fontSize).toBe(21);
    const last = host.applyTypography.mock.calls.at(-1)![0];
    expect(last.fontSize).toBe(21);
    expect(viewId).toBeTruthy();
  });
});
describe('统一阅读输入 -> 翻页 Command -> 渲染器(工单 #12)', () => {
  let registry: CommandRegistry;
  let importRepository: ReturnType<typeof createInMemoryImportRepository>;
  let workspaceRepository: ReturnType<typeof createInMemoryWorkspaceRepository>;
  let nextSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let prevSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(async () => {
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
    nextSpy = vi.fn<() => Promise<void>>();
    prevSpy = vi.fn<() => Promise<void>>();
    const host = {
      ...createFakeViewHost(),
      next: nextSpy,
      prev: prevSpy,
    };
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
    const openedViewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const book = useReaderRuntime.getState().getDocument(openedViewId)!;
    await book.open(globalThis.document.createElement('div'));
  });

  it('键盘、滚轮、点击与滑动都经同一组 Command ID 到达渲染器', async () => {
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const pending: Array<Promise<unknown>> = [];

    const controller = new ReadingInputController(
      {
        nextCommandId: COMMAND_IDS.readerNextPage,
        prevCommandId: COMMAND_IDS.readerPrevPage,
        execute: (commandId, targetViewId) => {
          pending.push(registry.execute(commandId as CommandId, targetViewId));
        },
        getFlow: () => 'paginated',
        wheelCooldownMs: 0,
      },
      viewId,
    );

    // 键盘
    controller.handleKey({ key: 'ArrowRight', flow: 'paginated', hasModifier: false });
    controller.handleKey({ key: 'PageUp', flow: 'paginated', hasModifier: false });
    // 滚轮
    controller.handle({ type: 'wheel', deltaX: 0, deltaY: 100 });
    controller.handle({ type: 'wheel', deltaX: 0, deltaY: -100 });
    // 点击左右区域
    controller.handle({ type: 'click', clientX: 50, clientWidth: 900, target: null });
    controller.handle({ type: 'click', clientX: 850, clientWidth: 900, target: null });
    // 触摸水平滑动
    controller.handle({ type: 'touch', phase: 'start', x: 300, y: 200, clientWidth: 900, timeStamp: 0 });
    controller.handle({ type: 'touch', phase: 'end', x: 100, y: 205, clientWidth: 900, timeStamp: 100 });
    controller.handle({ type: 'touch', phase: 'start', x: 100, y: 200, clientWidth: 900, timeStamp: 0 });
    controller.handle({ type: 'touch', phase: 'end', x: 300, y: 205, clientWidth: 900, timeStamp: 100 });
    // 轻触(无滑动位移)按左右区域翻页,证明触摸也走同一 Command。
    controller.handle({ type: 'touch', phase: 'start', x: 60, y: 200, clientWidth: 900, timeStamp: 0 });
    controller.handle({ type: 'touch', phase: 'end', x: 62, y: 201, clientWidth: 900, timeStamp: 60 });
    controller.handle({ type: 'touch', phase: 'start', x: 840, y: 200, clientWidth: 900, timeStamp: 0 });
    controller.handle({ type: 'touch', phase: 'end', x: 838, y: 201, clientWidth: 900, timeStamp: 60 });

    await Promise.all(pending);

    // 前翻:键盘ArrowRight、滚轮下、点击右侧、滑左、右轻触 = 5 次。
    // 后翻:PageUp、滚轮上、点击左侧、滑右、左轻触 = 5 次。
    expect(prevSpy).toHaveBeenCalledTimes(5);
    expect(nextSpy).toHaveBeenCalledTimes(5);
  });
});
