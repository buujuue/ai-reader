import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import {
  DEFAULT_WORKSPACE_STATE,
  WORKSPACE_STATE_SCHEMA_VERSION,
} from '../domain/workspace/workspaceState';
import { addInMemorySource } from '../domain/library/inMemoryImportRepository';
import { createInMemoryImportRepository } from '../domain/library/inMemoryImportRepository';
import { buildEpub } from '../domain/library/epub/zipWriter';
import { createInMemoryFilePicker } from './filePicker';
import {
  makeFakeDocument,
  makeFakeLib,
  makeFakeRasterizer,
} from '../domain/reader/pdf/pdfTestFakes';
import type { FoliateViewHost } from '../domain/reader/viewHost';
import {
  createAppServices,
  type AppServices,
  type WindowCloseRequestedEvent,
  type WindowLifecycle,
} from './bootstrap';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { useReaderRuntime } from '../workbench/readerRuntime';
import { useLibraryStore } from '../workbench/libraryStore';
import { useAnnotationStore } from '../workbench/annotationStore';
import { createInMemoryAnnotationRepository } from '../domain/annotation/inMemoryAnnotationRepository';
import type { Annotation } from '../domain/annotation/annotation';
import { App } from './App';
import { AppServicesProvider } from './AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';

function renderApp(services: AppServices) {
  return render(
    <AppServicesProvider services={services}>
      <App />
    </AppServicesProvider>,
  );
}

function createFakeViewHost(): FoliateViewHost {
  return {
    async open() {},
    async init() {},
    async next() {},
    async prev() {},
    goToLocation: vi.fn(async () => {}),
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
  };
}

describe('阅读工作台外壳', () => {
  let repository: WorkspaceRepository;
  let services: AppServices;

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    services = createAppServices({ workspaceRepository: repository });
    useWorkspaceStore.getState().resetToDefault();
    useAnnotationStore.getState().resetToDefault();
  });

  it('呈现简体中文工作台外壳', () => {
    renderApp(services);

    expect(screen.getByText('AI Reader')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '活动栏' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '书库侧栏' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '状态栏' })).toBeInTheDocument();
    expect(screen.getByText(/尚未导入阅读材料/)).toBeInTheDocument();
  });

  it('点击活动栏按钮通过 Command 往返隐藏主侧栏并持久化', async () => {
    const user = userEvent.setup();
    renderApp(services);

    const toggle = screen.getByRole('button', { name: '切换主侧栏' });
    await user.click(toggle);

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: '书库侧栏' })).not.toBeInTheDocument();
    });
    await expect(repository.loadState()).resolves.toEqual({
      ...DEFAULT_WORKSPACE_STATE,
      primarySidebarVisible: false,
    });
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(
      /已保存工作区状态/,
    );
  });

  it('再次点击按钮可以恢复主侧栏', async () => {
    const user = userEvent.setup();
    renderApp(services);

    const toggle = screen.getByRole('button', { name: '切换主侧栏' });
    await user.click(toggle);
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: '书库侧栏' })).not.toBeInTheDocument();
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(
        screen.getByRole('complementary', { name: '书库侧栏' }),
      ).toBeInTheDocument();
    });
  });

  it('启动时恢复此前持久化的侧栏隐藏状态', async () => {
    await repository.saveState({
      ...structuredClone(DEFAULT_WORKSPACE_STATE),
      primarySidebarVisible: false,
    });

    renderApp(services);
    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: '书库侧栏' }),
      ).not.toBeInTheDocument();
    });
    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
  });

  it('启动恢复工作区后检查 Markdown 恢复快照', async () => {
    const execute = vi.spyOn(services.commands, 'execute');

    renderApp(services);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith(COMMAND_IDS.markdownCheckRecoveries);
    });
  });

  it('桌面关闭请求会等待 Markdown 恢复快照落盘后再销毁窗口', async () => {
    let closeHandler: ((event: WindowCloseRequestedEvent) => void | Promise<void>) | null = null;
    let releaseFlush: (() => void) | null = null;
    const flushFinished = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const windowLifecycle: WindowLifecycle = {
      onCloseRequested: vi.fn(async (handler) => {
        closeHandler = handler;
        return () => undefined;
      }),
      destroy: vi.fn(async () => undefined),
    };
    services = createAppServices({ workspaceRepository: repository, windowLifecycle });
    const originalExecute = services.commands.execute.bind(services.commands);
    vi.spyOn(services.commands, 'execute').mockImplementation(async (commandId, ...args) => {
      if (commandId === COMMAND_IDS.markdownFlushRecoveries) await flushFinished;
      return originalExecute(commandId, ...args);
    });
    renderApp(services);
    await waitFor(() => expect(windowLifecycle.onCloseRequested).toHaveBeenCalledOnce());

    const preventDefault = vi.fn();
    const closing = closeHandler!({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(windowLifecycle.destroy).not.toHaveBeenCalled();
    releaseFlush!();
    await closing;
    expect(windowLifecycle.destroy).toHaveBeenCalledOnce();
  });

  it('点击导入按钮后书库侧栏显示导入的阅读材料', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));

    await waitFor(() => {
      expect(screen.getByText('示例书')).toBeInTheDocument();
    });
    expect(screen.getByText('示例作者')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(/已导入 1 份文件/);
  });

  it('导入后按标题/作者即时筛选书库,无匹配时显示空态', async () => {
    const user = userEvent.setup();
    renderApp(services);
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => {
      expect(screen.getByText('示例书')).toBeInTheDocument();
    });

    const search = screen.getByRole('searchbox', { name: '筛选书库' });
    await user.type(search, '示例作者');

    expect(screen.getByText('示例书')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '不存在的书名');

    expect(screen.getByText('没有匹配的材料')).toBeInTheDocument();
    expect(screen.queryByText('示例书')).not.toBeInTheDocument();
  });

  it('主要材料的批注侧栏按批注文本筛选并保持材料级集合', async () => {
    const annotationRepository = createInMemoryAnnotationRepository();
    const hosts: FoliateViewHost[] = [];
    services = createAppServices({
      workspaceRepository: repository,
      annotationRepository,
      viewHostFactory: () => {
        const host = createFakeViewHost();
        hosts.push(host);
        return host;
      },
    });
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getByText('示例书')).toBeInTheDocument());

    const materialId = useLibraryStore.getState().materials[0]!.id;
    const annotations: Annotation[] = [
      {
        id: 'annotation-1',
        materialId,
        anchor: {
          cfi: 'epubcfi(/6/4)!/4/2/2/1:0',
          quote: '第一段重要原文',
          before: '',
          after: '',
          documentVersion: 'fingerprint',
          recoveryState: 'resolved',
        },
        style: 'highlight',
        color: '#ffd54f',
        note: '需要回看',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      },
      {
        id: 'annotation-2',
        materialId,
        anchor: {
          cfi: 'epubcfi(/6/4)!/4/2/4/1:0',
          quote: '第二段原文',
          before: '',
          after: '',
          documentVersion: 'fingerprint',
          recoveryState: 'orphaned',
        },
        style: 'highlight',
        color: '#ffd54f',
        note: '已失联',
        createdAt: 2,
        updatedAt: 2,
        deletedAt: null,
      },
      {
        id: 'annotation-3',
        materialId,
        anchor: {
          cfi: 'pdf-text:2:0.10000:0.20000:0.30000:0.05000',
          quote: '',
          before: '',
          after: '',
          documentVersion: 'fingerprint',
          recoveryState: 'resolved',
        },
        style: 'highlight',
        color: '#ffd54f',
        note: '',
        createdAt: 3,
        updatedAt: 3,
        deletedAt: null,
      },
    ];
    for (const annotation of annotations) await annotationRepository.saveAnnotation(annotation);

    await user.click(screen.getByRole('button', { name: '设为主要材料 示例书' }));

    const sidebar = screen.getByRole('complementary', { name: '批注侧栏' });
    expect(sidebar).toHaveTextContent('第一段重要原文');
    expect(sidebar).toHaveTextContent('第二段原文');
    expect(sidebar).toHaveTextContent('失联');

    const search = screen.getByRole('searchbox', { name: '筛选批注' });
    await user.type(search, '需要回看');
    expect(sidebar).toHaveTextContent('第一段重要原文');
    expect(sidebar).not.toHaveTextContent('第二段原文');

    await user.clear(search);
    await user.click(screen.getByRole('button', { name: '跳转到批注 第一段重要原文' }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /示例书/ })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(hosts[0]?.goToLocation).toHaveBeenCalledWith('epubcfi(/6/4)!/4/2/2/1:0');
    });
  });

  it('批注侧栏的期望状态可以通过活动栏命令恢复', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '切换批注侧栏' }));
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: '批注侧栏' })).not.toBeInTheDocument();
    });
    await expect(repository.loadState()).resolves.toEqual({
      ...DEFAULT_WORKSPACE_STATE,
      annotationSidebarVisible: false,
    });
  });

  it('loads persisted primary material annotations before restoring views', async () => {
    const annotationRepository = createInMemoryAnnotationRepository();
    await annotationRepository.saveAnnotation({
      id: 'annotation-persisted',
      materialId: 'material-1',
      anchor: {
        cfi: 'epubcfi(/6/4)!/4/2/2/1:0',
        quote: 'persisted quote',
        before: '',
        after: '',
        documentVersion: 'fingerprint',
        recoveryState: 'resolved',
      },
      style: 'highlight',
      color: '#ffd54f',
      note: 'persisted note',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    });
    await repository.saveState({
      ...structuredClone(DEFAULT_WORKSPACE_STATE),
      primaryMaterialId: 'material-1',
    });
    services = createAppServices({ workspaceRepository: repository, annotationRepository });
    const execute = vi.spyOn(services.commands, 'execute');

    renderApp(services);

    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith(COMMAND_IDS.annotationLoadForMaterial, 'material-1');
    });
    expect(useAnnotationStore.getState().byMaterial['material-1']).toHaveLength(1);
  });
});

describe('回收站:安全删除资料', () => {
  let repository: WorkspaceRepository;
  let services: AppServices;

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    services = createAppServices({ workspaceRepository: repository });
    useWorkspaceStore.getState().resetToDefault();
    useLibraryStore.getState().resetToDefault();
  });

  async function importAndOpenTrash(user: ReturnType<typeof userEvent.setup>) {
    renderApp(services);
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => {
      expect(screen.getByText('示例书')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /移入回收站 示例书/ }));
    await waitFor(() => {
      expect(screen.queryByText('示例书')).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /回收站/ }));
  }

  it('普通删除把材料移入回收站并从活跃书库隐藏', async () => {
    const user = userEvent.setup();
    renderApp(services);
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => {
      expect(screen.getByText('示例书')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /移入回收站 示例书/ }));

    await waitFor(() => {
      expect(screen.queryByText('示例书')).not.toBeInTheDocument();
    });
    expect(useLibraryStore.getState().materials).toHaveLength(0);
    expect(useLibraryStore.getState().trashedMaterials).toHaveLength(1);
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(/已移入回收站/);
  });

  it('从回收站恢复后重新回到活跃书库', async () => {
    const user = userEvent.setup();
    await importAndOpenTrash(user);
    await waitFor(() => {
      expect(screen.getByLabelText(`永久删除 示例书`)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /恢复 示例书/ }));

    await waitFor(() => {
      expect(screen.getByText('示例书')).toBeInTheDocument();
    });
    expect(useLibraryStore.getState().trashedMaterials).toHaveLength(0);
    expect(useLibraryStore.getState().materials).toHaveLength(1);
  });

  it('永久删除前需二次确认,取消不会删除任何数据', async () => {
    const user = userEvent.setup();
    await importAndOpenTrash(user);
    await waitFor(() => {
      expect(screen.getByLabelText(`永久删除 示例书`)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /永久删除 示例书/ }));

    const dialog = screen.getByRole('dialog', { name: '永久删除确认' });
    expect(dialog).toBeInTheDocument();
    // 未输入书名时确认按钮禁用。
    expect(screen.getByRole('button', { name: '永久删除' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('dialog', { name: '永久删除确认' })).not.toBeInTheDocument();
    expect(useLibraryStore.getState().trashedMaterials).toHaveLength(1);
    expect(useLibraryStore.getState().materials).toHaveLength(0);
  });

  it('输入书名确认后永久删除,材料从回收站消失', async () => {
    const user = userEvent.setup();
    await importAndOpenTrash(user);
    await waitFor(() => {
      expect(screen.getByLabelText(`永久删除 示例书`)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /永久删除 示例书/ }));
    await user.type(screen.getByLabelText('输入书名以确认永久删除'), '示例书');

    await user.click(screen.getByRole('button', { name: '永久删除' }));

    await waitFor(() => {
      expect(useLibraryStore.getState().trashedMaterials).toHaveLength(0);
    });
    expect(screen.queryByRole('dialog', { name: '永久删除确认' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(/已永久删除/);
  });
});

describe('打开 EPUB 并重启续读', () => {
  let repository: WorkspaceRepository;
  let services: AppServices;

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    services = createAppServices({
      workspaceRepository: repository,
      viewHostFactory: () => createFakeViewHost(),
    });
    useWorkspaceStore.getState().resetToDefault();
  });

  it('从书库打开一本书后会新增阅读标签,再次点击会回到同一标签', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });

    await user.click(openButton);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /示例书/ })).toBeInTheDocument();
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });

    await user.click(openButton);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
      expect(screen.getAllByRole('tab', { name: /示例书/ })).toHaveLength(1);
    });
  });

  it('重启后从持久化状态恢复阅读标签与位置', async () => {
    // 先模拟一次会话:打开一本书并记录一个阅读位置。
    const user = userEvent.setup();
    const firstRender = renderApp(services);
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });
    await user.click(openButton);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });

    const materialId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.materialId;
    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    useWorkspaceStore.getState().setViewLocation(viewId, {
      kind: 'epub',
      cfi: 'epubcfi(/6/4)',
    });
    const workspace = useWorkspaceStore.getState();
    await repository.saveState({
      schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
      primarySidebarVisible: workspace.primarySidebarVisible,
      annotationSidebarVisible: workspace.annotationSidebarVisible,
      primaryMaterialId: workspace.primaryMaterialId,
      splitDirection: workspace.splitDirection,
      activeEditorGroupId: workspace.activeEditorGroupId,
      editorGroups: workspace.editorGroups,
      globalReadingTypography: workspace.globalReadingTypography,
      materialTypography: workspace.materialTypography,
    });

    // 模拟重启:卸载旧会话,重置 Store 与运行时,用同一 Repository 重新渲染。
    firstRender.unmount();
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
    renderApp(services);
    await waitFor(() => {
      const views = useWorkspaceStore.getState().editorGroups.flatMap((group) => group.views);
      expect(views).toHaveLength(1);
      expect(views[0]!.materialId).toBe(materialId);
      expect(views[0]!.location).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/4)' });
    });
  });

  it('标签栏后退/前进按钮执行导航历史命令', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });
    await user.click(openButton);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });

    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/1)' });
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/2)' });

    await user.click(screen.getByRole('button', { name: '后退' }));

    await waitFor(() => {
      const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
      expect(view.location).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/1)' });
    });

    await user.click(screen.getByRole('button', { name: '前进' }));

    await waitFor(() => {
      const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
      expect(view.location).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/2)' });
    });
  });

  it('重启多标签时只恢复活动标签的渲染器', async () => {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, 'first.epub', buildEpub({ title: '第一本书' }));
    addInMemorySource(sources, 'second.epub', buildEpub({ title: '第二本书' }));
    const importRepository = createInMemoryImportRepository(sources);
    const materials = [];
    for (const name of ['first.epub', 'second.epub']) {
      const staged = await importRepository.stageImport(name);
      const bytes = await importRepository.readStagedFile(staged);
      const { metadata } = await import('../domain/library/epub/epubInspector').then(({ inspectEpub }) =>
        inspectEpub(bytes),
      );
      materials.push(await importRepository.commitImport(staged, metadata));
    }

    const firstMaterial = materials[0]!;
    const secondMaterial = materials[1]!;
    const firstViewId = crypto.randomUUID();
    const secondViewId = crypto.randomUUID();
    const missingViewId = crypto.randomUUID();
    await repository.saveState({
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
            {
              id: missingViewId,
              materialId: 'missing-material',
              location: { kind: 'epub', cfi: 'epubcfi(/6/3)' },
              history: { positions: [], index: -1 },
              sourceMode: false,
            },
          ],
          activeViewId: missingViewId,
        },
      ],
    });
    services = createAppServices({
      workspaceRepository: repository,
      importRepository,
      filePicker: createInMemoryFilePicker([]),
      viewHostFactory: () => createFakeViewHost(),
    });

    renderApp(services);

    await waitFor(() => {
      expect(useReaderRuntime.getState().documents.size).toBe(1);
      expect(useReaderRuntime.getState().documents.has(firstViewId)).toBe(true);
    });
    expect(useReaderRuntime.getState().documents.has(secondViewId)).toBe(false);
    expect(useWorkspaceStore.getState().editorGroups[0]!.activeViewId).toBe(firstViewId);
    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(3);
  });

  it('重启后导航历史随工作区状态恢复', async () => {
    const user = userEvent.setup();
    const firstRender = renderApp(services);
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });
    await user.click(openButton);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });

    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/1)' });
    useWorkspaceStore.getState().pushViewLocation(viewId, { kind: 'epub', cfi: 'epubcfi(/6/2)' });
    const workspace = useWorkspaceStore.getState();
    await repository.saveState({
      schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
      primarySidebarVisible: workspace.primarySidebarVisible,
      annotationSidebarVisible: workspace.annotationSidebarVisible,
      primaryMaterialId: workspace.primaryMaterialId,
      splitDirection: workspace.splitDirection,
      activeEditorGroupId: workspace.activeEditorGroupId,
      editorGroups: workspace.editorGroups,
      globalReadingTypography: workspace.globalReadingTypography,
      materialTypography: workspace.materialTypography,
    });

    firstRender.unmount();
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
    renderApp(services);
    await waitFor(() => {
      const views = useWorkspaceStore.getState().editorGroups.flatMap((group) => group.views);
      expect(views).toHaveLength(1);
      expect(views[0]!.history.positions).toEqual([
        { kind: 'epub', cfi: 'epubcfi(/6/1)' },
        { kind: 'epub', cfi: 'epubcfi(/6/2)' },
      ]);
      expect(views[0]!.history.index).toBe(1);
    });
  });
});

describe('目录与外部链接', () => {
  let repository: WorkspaceRepository;
  let services: AppServices;

  function createTocFakeViewHost(): FoliateViewHost & { emitExternalLink: (href: string) => void } {
    const externalLinkListeners: Array<(href: string) => void> = [];
    const host = {
      ...createFakeViewHost(),
      getTOC: () => [
        { label: '第一章', href: 'chapter1.xhtml', subitems: null },
        {
          label: '第二章',
          href: 'chapter2.xhtml',
          subitems: [
            { label: '第二节', href: 'chapter2.xhtml#s2', subitems: null },
          ],
        },
      ],
      onExternalLink: (listener: (href: string) => void) => {
        externalLinkListeners.push(listener);
        return () => {
          const index = externalLinkListeners.indexOf(listener);
          if (index >= 0) externalLinkListeners.splice(index, 1);
        };
      },
      emitExternalLink: (href: string) => {
        for (const listener of externalLinkListeners) listener(href);
      },
    };
    return host;
  }

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    services = createAppServices({
      workspaceRepository: repository,
      viewHostFactory: () => createFakeViewHost(),
    });
    useWorkspaceStore.getState().resetToDefault();
  });

  it('活动栏目录按钮切换目录侧栏', async () => {
    const user = userEvent.setup();
    renderApp(services);

    const toggle = screen.getByRole('button', { name: '切换目录' });
    await user.click(toggle);

    expect(screen.getByRole('complementary', { name: '目录侧栏' })).toBeInTheDocument();

    await user.click(toggle);

    expect(screen.queryByRole('complementary', { name: '目录侧栏' })).not.toBeInTheDocument();
  });

  it('书内外部链接先展示目标对话框,确认后经 Command 交给系统浏览器', async () => {
    const host = createTocFakeViewHost();
    const opener = { open: vi.fn() };
    services = createAppServices({
      workspaceRepository: repository,
      viewHostFactory: () => host,
      externalUrlOpener: opener,
    });
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });
    await user.click(openButton);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });

    host.emitExternalLink('https://example.com');

    const dialog = await screen.findByRole('dialog', { name: '打开外部链接' });
    expect(dialog).toHaveTextContent('https://example.com');

    await user.click(screen.getByRole('button', { name: '在浏览器打开' }));

    await waitFor(() => {
      expect(opener.open).toHaveBeenCalledWith('https://example.com');
    });
    expect(screen.queryByRole('dialog', { name: '打开外部链接' })).not.toBeInTheDocument();
  });
});

describe('导入并阅读固定版式 PDF', () => {
  let repository: WorkspaceRepository;
  let services: AppServices;

  // 含 PDF 头的字节即可:伪 PDF.js 引擎负责解析,不依赖真实 PDF 结构。
  const pdfBytes = new TextEncoder().encode('%PDF-1.7\n');

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, '演示书/示例PDF.pdf', pdfBytes);
    const pdfDocument = makeFakeDocument(3);
    services = createAppServices({
      workspaceRepository: repository,
      importRepository: createInMemoryImportRepository(sources),
      filePicker: createInMemoryFilePicker(['演示书/示例PDF.pdf']),
      viewHostFactory: () => createFakeViewHost(),
      pdfLib: makeFakeLib(pdfDocument),
      pdfRasterize: makeFakeRasterizer(),
    });
    useWorkspaceStore.getState().resetToDefault();
    useLibraryStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });

    // PDF 渲染器在容器挂载时使用 ResizeObserver 与 canvas 2d 上下文。
    vi.stubGlobal(
      'ResizeObserver',
      class FakeResizeObserver {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
  });

  it('导入固定版式 PDF 后可从书库打开并创建阅读标签', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => {
      expect(screen.getByText('示例 PDF')).toBeInTheDocument();
    });
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(/已导入 1 份文件/);

    const openButton = await screen.findByRole('button', { name: /打开 示例 PDF/ });
    await user.click(openButton);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /示例 PDF/ })).toBeInTheDocument();
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });
  });

  it('带文字层的 PDF 支持当前材料搜索并跳转到对应页', async () => {
    // 给伪 PDF 首页注入带文字层的文本,使搜索能真正命中。
    const { makeFakePage } = await import('../domain/reader/pdf/pdfTestFakes');
    const textPage = makeFakePage({ width: 200, height: 300 }, [
      { str: '这段是关键词正文', transform: [10, 0, 0, 10, 20, 30], width: 60 },
    ]);
    const pdfDocument = makeFakeDocument(3);
    (pdfDocument.getPage as ReturnType<typeof vi.fn>).mockImplementation(async (n: number) =>
      n === 1 ? textPage : makeFakePage({ width: 200, height: 300 }, []),
    );

    const withTextServices = createAppServices({
      workspaceRepository: repository,
      importRepository: createInMemoryImportRepository(
        new Map([['演示书/示例PDF.pdf', new TextEncoder().encode('%PDF-1.7\n')]]),
      ),
      filePicker: createInMemoryFilePicker(['演示书/示例PDF.pdf']),
      viewHostFactory: () => createFakeViewHost(),
      pdfLib: makeFakeLib(pdfDocument),
      pdfRasterize: makeFakeRasterizer(),
    });
    useReaderRuntime.setState({ documents: new Map() });

    const user = userEvent.setup();
    renderApp(withTextServices);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getByText('示例 PDF')).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: /打开 示例 PDF/ }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /示例 PDF/ })).toBeInTheDocument());

    // 触发 Ctrl+F 打开搜索栏并输入关键词;搜索命中后应产生结果。
    await user.keyboard('{Control>}f{/Control}');
    const input = await screen.findByLabelText('搜索关键词');
    await user.type(input, '关键词');
    await waitFor(() => {
      expect(screen.getByRole('search')).toBeInTheDocument();
    });
    // 带文字层的 PDF 首页应产生命中显示(共 1 个命中)。
    await waitFor(() => {
      expect(screen.getByRole('search')).toHaveTextContent(/\/1\b/);
    });
  });
});
