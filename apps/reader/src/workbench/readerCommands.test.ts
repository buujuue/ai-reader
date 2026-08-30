import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_IDS, CommandRegistry, type CommandId } from '../commands/commandRegistry';
import { createInMemoryImportRepository, addInMemorySource } from '../domain/library/inMemoryImportRepository';
import { buildEpub } from '../domain/library/epub/zipWriter';
import { ManagedFileSource } from '../domain/library/managedFileSource';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { DEFAULT_WORKSPACE_STATE } from '../domain/workspace/workspaceState';
import type { BookDocument } from '../domain/reader/bookDocument';
import type { PdfReadingLocation } from '../domain/reader/readingLocation';
import type { FoliateViewHost } from '../domain/reader/viewHost';
import { ReadingInputController } from '../domain/reader/readingInput';
import type { SearchEvent } from '../domain/reader/search';
import { PdfBookDocument } from '../domain/reader/pdf/pdfBookDocument';
import { makeFakeDocument, makeFakeLib, makeFakeRasterizer } from '../domain/reader/pdf/pdfTestFakes';
import { mountViewDocument, registerReaderCommands } from './readerCommands';
import { ReaderRuntimeCache } from './readerRuntimeCache';
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

  async function setupWithPdfAndEpub() {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, 'demo.pdf', new TextEncoder().encode('%PDF-1.7\n测试 PDF'));
    addInMemorySource(sources, 'demo.epub', buildEpub({ title: '切换目标 EPUB' }));
    importRepository = createInMemoryImportRepository(sources);

    const pdfStage = await importRepository.stageImport('demo.pdf');
    const pdf = await importRepository.commitImport(pdfStage, {
      title: '演示 PDF',
      author: '示例作者',
      language: 'zh',
    });
    const epubStage = await importRepository.stageImport('demo.epub');
    const epubBytes = await importRepository.readStagedFile(epubStage);
    const { metadata } = await import('../domain/library/epub/epubInspector').then(({ inspectEpub }) =>
      inspectEpub(epubBytes),
    );
    const epub = await importRepository.commitImport(epubStage, metadata);
    return { pdf, epub };
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

  it('恢复 PDF 位置时不会让恢复完成后的过期位置事件覆盖目标位置', async () => {
    const viewId = 'pdf-restore-view';
    const savedLocation: PdfReadingLocation = {
      kind: 'pdf',
      page: 7,
      scrollTop: 4_321.5,
      zoom: 150,
      fit: 'actual',
    };
    const staleLocation: PdfReadingLocation = {
      kind: 'pdf',
      page: 1,
      scrollTop: 0,
      zoom: 100,
      fit: 'width',
    };
    useWorkspaceStore.getState().hydrate({
      ...DEFAULT_WORKSPACE_STATE,
      activeEditorGroupId: 'group-1',
      editorGroups: [
        {
          id: 'group-1',
          views: [
            {
              id: viewId,
              materialId: 'pdf-material',
              location: savedLocation,
              history: { positions: [], index: -1 },
              sourceMode: false,
            },
          ],
          activeViewId: viewId,
        },
      ],
    });

    const listeners = new Set<(location: PdfReadingLocation) => void>();
    let currentLocation = savedLocation;
    const emit = (location: PdfReadingLocation) => {
      currentLocation = location;
      for (const listener of listeners) listener(location);
    };
    const restore = vi.fn(async (location: PdfReadingLocation) => {
      emit(location);
      await Promise.resolve();
      // 模拟 PDF 首屏重排在恢复完成后才到达的旧位置事件。
      emit(staleLocation);
    });
    const book = {
      format: 'pdf',
      metadata: { title: '测试 PDF', author: null, language: 'zh' },
      async open() {
        emit(staleLocation);
      },
      getLocation: () => currentLocation,
      goToLocation: restore,
      onLocationChange(listener: (location: PdfReadingLocation) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      applyTypography() {},
      onInternalLink() {
        return () => undefined;
      },
      onExternalLink() {
        return () => undefined;
      },
    } as unknown as BookDocument;
    useReaderRuntime.getState().setDocument(viewId, book);

    const persister = mountViewDocument(book, viewId, document.createElement('div'), savedLocation, {
      importRepository,
      workspaceRepository,
    });

    await vi.waitFor(() => expect(restore).toHaveBeenCalledWith(savedLocation));
    expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location).toEqual(savedLocation);
    await persister.dispose();
  });

  it('PDF 与其他材料互切后恢复页码、滚动位置和视口状态', async () => {
    const { pdf, epub } = await setupWithPdfAndEpub();
    vi.stubGlobal(
      'ResizeObserver',
      class FakeResizeObserver {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const pdfLib = makeFakeLib(makeFakeDocument(8));
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
      pdfLib,
      pdfRasterize: makeFakeRasterizer(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, pdf);
    const pdfViewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const pdfDocument = useReaderRuntime.getState().getDocument(pdfViewId)!;
    const firstPersister = mountViewDocument(
      pdfDocument,
      pdfViewId,
      document.createElement('div'),
      null,
      { importRepository, workspaceRepository },
    );
    await vi.waitFor(() => expect(pdfDocument).toBeInstanceOf(PdfBookDocument));
    await vi.waitFor(() => expect((pdfDocument as PdfBookDocument).getPageCount()).toBe(8));

    const paginatedLocation: PdfReadingLocation = {
      kind: 'pdf',
      page: 4,
      scrollTop: 0,
      zoom: 125,
      fit: 'page',
    };
    await pdfDocument.goToLocation(paginatedLocation);

    await registry.execute(COMMAND_IDS.libraryOpenBook, epub);
    expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location).toEqual(paginatedLocation);
    const persistedAfterSwitch = await workspaceRepository.loadState();
    expect(persistedAfterSwitch.editorGroups[0]!.views[0]!.location).toEqual(paginatedLocation);

    await registry.execute(COMMAND_IDS.readerActivateView, pdfViewId, pdf);
    const reopenedPaginated = useReaderRuntime.getState().getDocument(pdfViewId)!;
    const secondPersister = mountViewDocument(
      reopenedPaginated,
      pdfViewId,
      document.createElement('div'),
      useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location,
      { importRepository, workspaceRepository },
    );
    await vi.waitFor(() => expect((reopenedPaginated as PdfBookDocument).getPageCount()).toBe(8));
    expect(reopenedPaginated.getLocation()).toEqual(paginatedLocation);

    await registry.execute(COMMAND_IDS.readerSetPdfFlow, pdfViewId, 'scrolled');
    const scrolledLocation: PdfReadingLocation = {
      kind: 'pdf',
      page: 4,
      scrollTop: 5_321.25,
      zoom: 175,
      fit: 'actual',
    };
    await reopenedPaginated.goToLocation(scrolledLocation);

    await registry.execute(COMMAND_IDS.libraryOpenBook, epub);
    expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location).toEqual(scrolledLocation);
    const persistedAfterScrolledSwitch = await workspaceRepository.loadState();
    expect(persistedAfterScrolledSwitch.editorGroups[0]!.views[0]!.location).toEqual(scrolledLocation);

    await registry.execute(COMMAND_IDS.readerActivateView, pdfViewId, pdf);
    const reopened = useReaderRuntime.getState().getDocument(pdfViewId)!;
    const thirdPersister = mountViewDocument(
      reopened,
      pdfViewId,
      document.createElement('div'),
      useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location,
      { importRepository, workspaceRepository },
    );
    await vi.waitFor(() => expect((reopened as PdfBookDocument).getPageCount()).toBe(8));
    expect(reopened.getLocation()).toEqual(scrolledLocation);

    // 模拟应用重启:只保留序列化 Workspace,释放所有 PDF.js 活对象后重新恢复活动视图。
    const restartWorkspace = structuredClone(persistedAfterScrolledSwitch);
    restartWorkspace.activeEditorGroupId = 'group-1';
    restartWorkspace.editorGroups[0]!.activeViewId = pdfViewId;
    await thirdPersister.dispose();
    useReaderRuntime.getState().closeAll();
    useWorkspaceStore.getState().hydrate(restartWorkspace);
    await registry.execute(COMMAND_IDS.readerRestoreView, pdfViewId, pdf, scrolledLocation);
    const restoredAfterRestart = useReaderRuntime.getState().getDocument(pdfViewId)!;
    const restartPersister = mountViewDocument(
      restoredAfterRestart,
      pdfViewId,
      document.createElement('div'),
      scrolledLocation,
      { importRepository, workspaceRepository },
    );
    await vi.waitFor(() => expect((restoredAfterRestart as PdfBookDocument).getPageCount()).toBe(8));
    expect(restoredAfterRestart.getLocation()).toEqual(scrolledLocation);
    expect(pdfLib.getDocument).toHaveBeenCalledTimes(4);

    await firstPersister.dispose();
    await secondPersister.dispose();
    await restartPersister.dispose();
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

  it('PDF 双 Editor Group 各自挂载时每个 Runtime 只创建一次 PDF.js 文档', async () => {
    const { pdf } = await setupWithPdfAndEpub();
    vi.stubGlobal(
      'ResizeObserver',
      class FakeResizeObserver {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const pdfLib = makeFakeLib(makeFakeDocument(2));
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      pdfLib,
      pdfRasterize: makeFakeRasterizer(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, pdf);
    const firstViewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const firstDocument = useReaderRuntime.getState().getDocument(firstViewId)!;
    const firstContainer = document.createElement('div');
    mountViewDocument(firstDocument, firstViewId, firstContainer, null, {
      importRepository,
      workspaceRepository,
    });
    await vi.waitFor(() => expect(firstContainer.querySelector('[data-page="1"]')).not.toBeNull());

    await registry.execute(COMMAND_IDS.workbenchSplitEditorGroupRight);
    const secondViewId = useWorkspaceStore.getState().editorGroups[1]!.views[0]!.id;
    const secondDocument = useReaderRuntime.getState().getDocument(secondViewId)!;
    const secondContainer = document.createElement('div');
    mountViewDocument(secondDocument, secondViewId, secondContainer, null, {
      importRepository,
      workspaceRepository,
    });
    await vi.waitFor(() => expect(secondContainer.querySelector('[data-page="1"]')).not.toBeNull());

    expect(useReaderRuntime.getState().documents.size).toBe(2);
    expect(pdfLib.getDocument).toHaveBeenCalledTimes(2);
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

  it('活动 Runtime 的材料键变化时安全重建而不复用旧对象', async () => {
    const material = await setupWithEpub();
    const openManagedFileSource = vi.spyOn(importRepository, 'openManagedFileSource');
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const original = useReaderRuntime.getState().getDocument(viewId);
    const changedMaterial = { ...material, fingerprint: 'changed-content-fingerprint' };

    await registry.execute(COMMAND_IDS.readerActivateView, viewId, changedMaterial);

    const rebuilt = useReaderRuntime.getState().getDocument(viewId);
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(original);
    expect(openManagedFileSource).toHaveBeenCalledTimes(2);
  });

  it('快速连续打开不同材料时最终活动视图不会被过期运行时覆盖', async () => {
    const materials = await setupWithEpubMaterials();
    const firstMaterial = materials[0]!;
    const secondMaterial = materials[1]!;
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    await Promise.all([
      registry.execute(COMMAND_IDS.libraryOpenBook, firstMaterial),
      registry.execute(COMMAND_IDS.libraryOpenBook, secondMaterial),
    ]);

    const group = useWorkspaceStore.getState().editorGroups[0]!;
    const firstViewId = group.views.find((view) => view.materialId === firstMaterial.id)!.id;
    const secondViewId = group.views.find((view) => view.materialId === secondMaterial.id)!.id;
    expect(group.activeViewId).toBe(secondViewId);
    expect(useReaderRuntime.getState().documents.size).toBe(1);
    expect(useReaderRuntime.getState().documents.has(firstViewId)).toBe(false);
    expect(useReaderRuntime.getState().documents.has(secondViewId)).toBe(true);
  });

  it('切换 EPUB 标签时保留一个有限挂起 Runtime 并命中同一渲染器', async () => {
    const [firstMaterial, secondMaterial] = await setupWithEpubMaterials();
    const readerRuntimeCache = new ReaderRuntimeCache();
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
      readerRuntimeCache,
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
    await vi.waitFor(() =>
      expect(useReaderRuntime.getState().getDocument(firstViewId)?.isRuntimeReady?.()).toBe(true),
    );
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
    await vi.waitFor(() =>
      expect(useReaderRuntime.getState().getDocument(secondViewId)?.isRuntimeReady?.()).toBe(true),
    );
    expect(useWorkspaceStore.getState().editorGroups[0]!.activeViewId).toBe(secondViewId);
    expect(useReaderRuntime.getState().documents.size).toBe(2);
    expect(useReaderRuntime.getState().documents.has(firstViewId)).toBe(true);
    expect(useReaderRuntime.getState().getDocumentLifecycle(firstViewId)).toBe('suspended');
    expect(hosts[0]!.close).not.toHaveBeenCalled();
    expect(readerRuntimeCache.getDiagnostics().entries).toHaveLength(2);
    const suspendedFirstDocument = useReaderRuntime.getState().getDocument(firstViewId);

    await registry.execute(COMMAND_IDS.readerActivateView, firstViewId);

    expect(useWorkspaceStore.getState().editorGroups[0]!.activeViewId).toBe(firstViewId);
    expect(useReaderRuntime.getState().documents.size).toBe(2);
    expect(useReaderRuntime.getState().documents.has(firstViewId)).toBe(true);
    expect(useReaderRuntime.getState().getDocumentLifecycle(firstViewId)).toBe('active');
    expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location).toEqual(savedLocation);
    expect(hosts[1]!.close).not.toHaveBeenCalled();

    const activeDocument = useReaderRuntime.getState().getDocument(firstViewId)!;
    expect(activeDocument).toBe(suspendedFirstDocument);
    expect(activeDocument.isRuntimeReady?.()).toBe(true);
    const resumedContainer = document.createElement('div');
    expect(activeDocument.attach?.(resumedContainer)).toBe(true);
    mountViewDocument(activeDocument, firstViewId, resumedContainer, savedLocation, {
      importRepository,
      workspaceRepository,
    });
    expect(hosts).toHaveLength(2);
    expect(hosts[0]!.goToLocation).not.toHaveBeenCalled();
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

  it('PDF 打开命令、BookDocument 挂载和首屏只创建一次 PDF.js 文档,并复用书库有效元数据', async () => {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, '演示书/范围.pdf', new TextEncoder().encode('%PDF-1.7\n'));
    importRepository = createInMemoryImportRepository(sources);
    const staged = await importRepository.stageImport('演示书/范围.pdf');
    const material = await importRepository.commitImport(staged, {
      title: '书库有效标题',
      author: '书库有效作者',
      language: 'zh-CN',
    });
    const openManagedFileSource = vi.spyOn(importRepository, 'openManagedFileSource');
    const pdfDocument = makeFakeDocument(640);
    const pdfLib = makeFakeLib(pdfDocument);
    const largeSize = 640 * 128 * 1024;
    const readRange = vi.fn(async (_offset: number, length: number) => new Uint8Array(length));
    const source = new ManagedFileSource(
      { name: '范围.pdf', size: largeSize },
      readRange,
    );
    openManagedFileSource.mockResolvedValue(source);
    (pdfLib.getDocument as ReturnType<typeof vi.fn>).mockImplementation((options) => {
      // 模拟 600 页以上真实问题样本的文件头 + 文件尾范围访问。
      options.range.requestDataRange?.(0, 64);
      options.range.requestDataRange?.(largeSize - 64, largeSize);
      return { promise: Promise.resolve(pdfDocument) };
    });
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      pdfLib,
      pdfRasterize: makeFakeRasterizer(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, material);

    expect(openManagedFileSource).toHaveBeenCalledWith(material.id);
    expect(openManagedFileSource).toHaveBeenCalledTimes(1);
    expect(pdfLib.getDocument).not.toHaveBeenCalled();
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const book = useReaderRuntime.getState().getDocument(viewId)!;
    expect(book.metadata).toEqual({
      title: '书库有效标题',
      author: '书库有效作者',
      language: 'zh-CN',
    });

    vi.stubGlobal(
      'ResizeObserver',
      class FakeResizeObserver {
        observe(): void {}
        disconnect(): void {}
      },
    );
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    mountViewDocument(book, viewId, container, null, {
      importRepository,
      workspaceRepository,
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-page="1"]')).not.toBeNull();
    });
    expect(pdfLib.getDocument).toHaveBeenCalledTimes(1);
    expect(readRange).toHaveBeenCalledTimes(2);
    expect(new Set(readRange.mock.calls.map(([offset]) => offset)).size).toBe(2);
    const options = (pdfLib.getDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(options).not.toHaveProperty('data');
    expect(options).toEqual(expect.objectContaining({ range: expect.anything() }));
  });

  it('PDF.js 损坏错误在阅读挂载阶段直接转换为简体中文诊断', async () => {
    const { pdf } = await setupWithPdfAndEpub();
    const pdfLib = makeFakeLib(makeFakeDocument(1));
    (pdfLib.getDocument as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      promise: Promise.reject(new Error('Invalid PDF structure')),
    }));
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      pdfLib,
      pdfRasterize: makeFakeRasterizer(),
    });

    await registry.execute(COMMAND_IDS.libraryOpenBook, pdf);
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
        message: expect.stringContaining('PDF 文件损坏或结构无效'),
      });
    });
    expect(pdfLib.getDocument).toHaveBeenCalledTimes(1);
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
