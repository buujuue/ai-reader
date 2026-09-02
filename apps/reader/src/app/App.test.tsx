import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { createInMemoryWorkbenchAppearancePreferences } from './workbenchAppearance';
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
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkbenchAppearanceStore } from '../workbench/appearanceStore';
import { createInMemoryAnnotationRepository } from '../domain/annotation/inMemoryAnnotationRepository';
import { createInMemoryLibraryFolderRepository } from '../domain/library/inMemoryLibraryFolderRepository';
import type { LibraryFolder } from '../domain/library/libraryFolder';
import type { BackupRepository } from '../domain/library/backupRepository';
import type { BackupDestinationPicker } from './backupDestinationPicker';
import type { BackupSourcePicker } from './backupSourcePicker';
import type { Annotation } from '../domain/annotation/annotation';
import { App } from './App';
import { AppServicesProvider } from './AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import {
  LIBRARY_MATERIAL_DRAG_TYPE,
  writeLibraryMaterialDragPayload,
} from '../components/libraryDragDrop';

function renderApp(services: AppServices) {
  return render(
    <AppServicesProvider services={services}>
      <App />
    </AppServicesProvider>,
  );
}

function createDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    files: [],
    items: [],
    types: [],
    clearData: () => values.clear(),
    getData: (format: string) => values.get(format) ?? '',
    setData: (format: string, data: string) => {
      values.set(format, data);
    },
    setDragImage: () => undefined,
  } as unknown as DataTransfer;
}

function createFakeViewHost(): FoliateViewHost {
  return {
    async open() {},
    init: vi.fn(async () => {}),
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
    useLibraryStore.getState().resetToDefault();
    useReaderRuntime.getState().closeAll();
    useAnnotationStore.getState().resetToDefault();
    useShellUiStore.getState().closeAnnotationPanel();
    useShellUiStore.getState().closeFolderDeleteConfirm();
    useShellUiStore.getState().restoreCompactActivityPanel();
    useWorkbenchAppearanceStore.getState().resetToDefault();
  });

  it('呈现简体中文工作台外壳', () => {
    renderApp(services);

    expect(screen.getByRole('heading', { name: 'AI Reader' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '活动栏' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '书库侧栏' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '状态栏' })).toBeInTheDocument();
    expect(screen.getByText(/尚未导入阅读材料/)).toBeInTheDocument();
  });

  it('左侧面板手柄支持键盘调整并持久化宽度', async () => {
    renderApp(services);

    const handle = screen.getByRole('separator', { name: '调整左侧面板宽度' });
    expect(handle).toHaveAttribute('aria-valuenow', '304');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(handle).toHaveAttribute('aria-valuenow', '316');
    });
    await expect(repository.loadState()).resolves.toMatchObject({ activityPanelWidth: 316 });
  });

  it('默认生产入口呈现 C 工作台顶栏并提供三个活动入口', () => {
    renderApp(services);

    expect(document.querySelector('.app-shell.workbench-prototype')).toHaveAttribute(
      'data-theme',
      'midnight',
    );
    expect(screen.getByRole('banner', { name: '应用顶栏' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '书库' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '目录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '界面' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '切换批注侧栏' })).not.toBeInTheDocument();
  });

  it('应用顶栏菜单只呈现真实生产动作', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '文件' }));
    expect(screen.getByRole('menu', { name: '文件菜单' })).toHaveTextContent('导入阅读材料');
    expect(screen.getByRole('menu', { name: '文件菜单' })).toHaveTextContent('导出完整备份');
    expect(screen.getByRole('menu', { name: '文件菜单' })).toHaveTextContent('恢复完整备份');
    expect(screen.getByRole('menu', { name: '文件菜单' })).toHaveTextContent('关闭当前材料');
    expect(screen.queryByText('Agent 侧栏')).not.toBeInTheDocument();
    expect(screen.queryByText('切换到浅色主题')).not.toBeInTheDocument();
  });

  it('应用顶栏备份与恢复入口经同一 Command 调用 typed Repository', async () => {
    const backupRepository: BackupRepository = {
      exportBackup: vi.fn(async (destinationPath) => ({
        destinationPath,
        entryCount: 9,
        totalBytes: 4096,
      })),
      restoreBackup: vi.fn(async () => ({
        materialCount: 2,
        entryCount: 9,
        totalBytes: 4096,
      })),
    };
    const backupDestinationPicker: BackupDestinationPicker = {
      pickBackupDestination: vi.fn(async () => 'library.airbackup'),
    };
    const backupSourcePicker: BackupSourcePicker = {
      pickBackupSource: vi.fn(async () => 'library.airbackup'),
    };
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    services = createAppServices({
      workspaceRepository: repository,
      backupRepository,
      backupDestinationPicker,
      backupSourcePicker,
    });
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '文件' }));
    await user.click(screen.getByRole('menuitem', { name: '导出完整备份…' }));
    await waitFor(() => {
      expect(backupRepository.exportBackup).toHaveBeenCalledWith('library.airbackup');
    });

    await user.click(screen.getByRole('button', { name: '文件' }));
    await user.click(screen.getByRole('menuitem', { name: '恢复完整备份…' }));
    await waitFor(() => {
      expect(backupRepository.restoreBackup).toHaveBeenCalledWith('library.airbackup');
    });
    expect(useShellUiStore.getState().statusMessage).toBe('书库恢复成功，共恢复 2 本书');
    confirmSpy.mockRestore();
  });

  it('点击活动栏按钮通过 Command 往返隐藏主侧栏并持久化', async () => {
    const user = userEvent.setup();
    renderApp(services);

    const toggle = screen.getByRole('button', { name: '书库' });
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

    const toggle = screen.getByRole('button', { name: '书库' });
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

  it('界面活动入口通过 Command 切换面板并与书库、目录互斥', async () => {
    const user = userEvent.setup();
    renderApp(services);

    const toggle = screen.getByRole('button', { name: '界面' });
    expect(screen.queryByRole('complementary', { name: '界面侧栏' })).not.toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('complementary', { name: '界面侧栏' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('complementary', { name: '书库侧栏' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: '目录侧栏' })).not.toBeInTheDocument();
    await expect(repository.loadState()).resolves.toMatchObject({
      primarySidebarVisible: false,
      tocVisible: false,
      interfacePanelVisible: true,
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: '界面侧栏' })).not.toBeInTheDocument();
    });
    await expect(repository.loadState()).resolves.toMatchObject({ interfacePanelVisible: false });
  });

  it('界面面板展示五套工作台主题并独立保存背景光偏好', async () => {
    const appearancePreferences = createInMemoryWorkbenchAppearancePreferences({
      theme: 'apple',
      glowEnabled: false,
    });
    services = createAppServices({ workspaceRepository: repository, appearancePreferences });
    const user = userEvent.setup();
    renderApp(services);
    await user.click(screen.getByRole('button', { name: '界面' }));

    const panel = screen.getByRole('complementary', { name: '界面侧栏' });
    expect(within(panel).getByRole('button', { name: /极夜黑/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(panel).getByRole('button', { name: /苹果白/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(panel).getByRole('button', { name: /Claude 护眼/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /清新绿/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /柔雾粉/ })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: /Claude 护眼/ }));
    expect(document.querySelector('.app-shell.workbench-prototype')).toHaveAttribute(
      'data-theme',
      'claude',
    );
    expect(useWorkbenchAppearanceStore.getState().glowEnabled).toBe(false);

    const glow = within(panel).getByRole('switch', { name: '背景光效果' });
    expect(glow).toHaveAttribute('aria-checked', 'false');
    await user.click(glow);
    expect(glow).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.workbenchGlow).toBe('on');
    expect(appearancePreferences.load()).toEqual({ theme: 'claude', glowEnabled: true });
  });

  it('紧凑布局以覆盖抽屉呈现界面面板并可由同一入口关闭', async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
    try {
      const user = userEvent.setup();
      renderApp(services);
      await waitFor(() => {
        expect(document.querySelector('[data-layout-mode="compact"]')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: '界面' }));
      await waitFor(() => {
        expect(screen.getByRole('complementary', { name: '界面侧栏' })).toBeInTheDocument();
      });
      expect(document.querySelector('[data-sidebar-presentation="overlay"]')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '界面' }));
      await waitFor(() => {
        expect(screen.queryByRole('complementary', { name: '界面侧栏' })).not.toBeInTheDocument();
      });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
    }
  });

  it('紧凑布局打开材料后收起抽屉并允许切换目录', async () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
    try {
      services = createAppServices({
        workspaceRepository: repository,
        viewHostFactory: () => createFakeViewHost(),
      });
      const user = userEvent.setup();
      renderApp(services);
      await waitFor(() =>
        expect(document.querySelector('[data-layout-mode="compact"]')).toBeInTheDocument(),
      );

      await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
      await waitFor(() => expect(screen.getAllByText('示例书').length).toBeGreaterThan(0));
      const search = screen.getByRole('searchbox', { name: '筛选书库' });
      await user.type(search, '示例');
      await user.click(screen.getByRole('button', { name: '打开 示例书' }));

      await waitFor(() =>
        expect(screen.queryByRole('complementary', { name: '书库侧栏' })).not.toBeInTheDocument(),
      );
      expect(useShellUiStore.getState().compactActivityPanelDismissed).toBe(true);

      await user.click(screen.getByRole('button', { name: '书库' }));
      await waitFor(() =>
        expect(screen.getByRole('complementary', { name: '书库侧栏' })).toBeInTheDocument(),
      );
      expect(screen.getByRole('searchbox', { name: '筛选书库' })).toHaveValue('示例');
      await user.click(screen.getByRole('button', { name: '目录' }));
      await waitFor(() =>
        expect(screen.getByRole('complementary', { name: '目录侧栏' })).toBeInTheDocument(),
      );
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
    }
  });

  it('启动时恢复此前持久化的侧栏隐藏状态', async () => {
    await repository.saveState({
      ...structuredClone(DEFAULT_WORKSPACE_STATE),
      primarySidebarVisible: false,
      tocVisible: true,
    });

    renderApp(services);
    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: '书库侧栏' }),
      ).not.toBeInTheDocument();
    });
    expect(useWorkspaceStore.getState().primarySidebarVisible).toBe(false);
    expect(useWorkspaceStore.getState().tocVisible).toBe(true);
    expect(screen.getByRole('complementary', { name: '目录侧栏' })).toBeInTheDocument();
  });

  it('启动时恢复此前持久化的界面面板显示状态', async () => {
    await repository.saveState({
      ...structuredClone(DEFAULT_WORKSPACE_STATE),
      primarySidebarVisible: false,
      tocVisible: false,
      interfacePanelVisible: true,
    });

    renderApp(services);
    await waitFor(() => {
      expect(screen.getByRole('complementary', { name: '界面侧栏' })).toBeInTheDocument();
    });
    expect(useWorkspaceStore.getState().interfacePanelVisible).toBe(true);
    expect(screen.queryByRole('complementary', { name: '书库侧栏' })).not.toBeInTheDocument();
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
      expect(screen.getAllByText('示例书').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('示例作者')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(/已导入 1 份文件/);
  });

  it('导入后按标题/作者即时筛选书库,无匹配时显示空态', async () => {
    const user = userEvent.setup();
    renderApp(services);
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => {
      expect(screen.getAllByText('示例书').length).toBeGreaterThan(0);
    });

    const search = screen.getByRole('searchbox', { name: '筛选书库' });
    await user.type(search, '示例作者');

    expect(screen.getAllByText('示例书').length).toBeGreaterThan(0);

    await user.clear(search);
    await user.type(search, '不存在的书名');

    expect(screen.getByText('没有匹配的材料')).toBeInTheDocument();
    expect(screen.queryByText('示例书')).not.toBeInTheDocument();
  });

  it('搜索文件夹树时展示完整路径并只临时展开命中路径,清空后恢复原状态', async () => {
    const folderRepository = createInMemoryLibraryFolderRepository();
    const importRepository = services.importRepository;
    const root = await folderRepository.createFolder('历史', null);
    const child = await folderRepository.createFolder('欧洲', root.id);
    const staged = await importRepository.stageImport('演示书/示例书.epub');
    const material = await importRepository.commitImport(staged, {
      title: '法国史',
      author: '作者甲',
      language: 'zh',
    });
    await importRepository.moveMaterialToFolder(material.id, child.id);
    await repository.saveState({
      ...DEFAULT_WORKSPACE_STATE,
      expandedLibraryFolderIds: [],
    });
    services = createAppServices({
      workspaceRepository: repository,
      importRepository,
      filePicker: services.filePicker,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });

    const user = userEvent.setup();
    renderApp(services);
    await waitFor(() => expect(screen.getByRole('tree', { name: '书库文件夹树' })).toBeInTheDocument());

    const search = screen.getByRole('searchbox', { name: '筛选书库' });
    await user.type(search, '作者甲');

    expect(screen.getByText('路径：历史 / 欧洲')).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: '文件夹 历史' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: '文件夹 欧洲' })).toHaveAttribute('aria-expanded', 'true');
    await expect(repository.loadState()).resolves.toMatchObject({ expandedLibraryFolderIds: [] });

    await user.clear(search);

    expect(screen.getByRole('treeitem', { name: '文件夹 历史' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: '文件夹 欧洲' })).not.toBeInTheDocument();
    await expect(repository.loadState()).resolves.toMatchObject({ expandedLibraryFolderIds: [] });
  });

  it('重启恢复书库时忽略失效 FolderId,不阻塞书库显示', async () => {
    const folderRepository = createInMemoryLibraryFolderRepository();
    const validFolder = await folderRepository.createFolder('仍存在', null);
    await repository.saveState({
      ...DEFAULT_WORKSPACE_STATE,
      expandedLibraryFolderIds: ['folder-deleted', validFolder.id],
    });
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
    });

    renderApp(services);

    await waitFor(() => expect(screen.getByRole('treeitem', { name: '文件夹 仍存在' })).toBeInTheDocument());
    expect(useWorkspaceStore.getState().expandedLibraryFolderIds).toEqual([validFolder.id]);
    await expect(repository.loadState()).resolves.toMatchObject({
      expandedLibraryFolderIds: [validFolder.id],
    });
  });

  it('未归类折叠状态进入工作区并在重启后恢复', async () => {
    const user = userEvent.setup();
    const { unmount } = renderApp(services);
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getAllByText('示例书').length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: '收起未归类材料' }));
    await waitFor(() => expect(useWorkspaceStore.getState().unfiledMaterialsExpanded).toBe(false));
    await expect(repository.loadState()).resolves.toMatchObject({ unfiledMaterialsExpanded: false });

    unmount();
    useLibraryStore.getState().resetToDefault();
    useWorkspaceStore.getState().resetToDefault();
    services = createAppServices({
      workspaceRepository: repository,
      importRepository: services.importRepository,
      filePicker: services.filePicker,
      libraryFolderRepository: services.libraryFolderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    renderApp(services);

    await waitFor(() => expect(screen.getByRole('button', { name: '展开未归类材料' })).toBeInTheDocument());
    expect(useWorkspaceStore.getState().unfiledMaterialsExpanded).toBe(false);
  });

  it('未归类区位于文件夹树下方并支持折叠,搜索不会改写持久展开状态', async () => {
    const user = userEvent.setup();
    renderApp(services);
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '收起未归类材料' })).toBeInTheDocument());

    const unfiled = screen.getByRole('button', { name: '收起未归类材料' });
    const folderTree = screen.getByRole('tree', { name: '书库文件夹树' });
    expect(folderTree).not.toHaveTextContent('示例书');
    await user.click(unfiled);
    await waitFor(() => expect(screen.getByRole('button', { name: '展开未归类材料' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '打开 示例书' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '展开未归类材料' }));
    expect(screen.getByRole('button', { name: '打开 示例书' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '收起未归类材料' }));

    const search = screen.getByRole('searchbox', { name: '筛选书库' });
    await user.type(search, '示例书');
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    await expect(repository.loadState()).resolves.toMatchObject({ unfiledMaterialsExpanded: false });
  });

  it('材料更多菜单打开批注覆盖面板并按批注文本筛选', async () => {
    const annotationRepository = createInMemoryAnnotationRepository();
    const exportDestinationPicker = {
      pickAnnotationExportDestination: vi.fn(async () => 'notes.md'),
    };
    const exportWriter = {
      writeMarkdown: vi.fn(async () => undefined),
    };
    const hosts: FoliateViewHost[] = [];
    services = createAppServices({
      workspaceRepository: repository,
      annotationRepository,
      annotationExportDestinationPicker: exportDestinationPicker,
      annotationExportWriter: exportWriter,
      viewHostFactory: () => {
        const host = createFakeViewHost();
        hosts.push(host);
        return host;
      },
    });
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getAllByText('示例书').length).toBeGreaterThan(0));

    const importedMaterials = await services.importRepository.listMaterials();
    const material = importedMaterials[importedMaterials.length - 1]!;
    const materialId = material.id;
    const fingerprint = material.fingerprint;
    const annotations: Annotation[] = [
      {
        id: 'annotation-1',
        materialId,
        anchor: {
          cfi: 'epubcfi(/6/4)!/4/2/2/1:0',
          quote: '第一段重要原文',
          before: '',
          after: '',
          documentVersion: fingerprint,
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
          documentVersion: fingerprint,
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
          documentVersion: fingerprint,
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

    await services.commands.execute(COMMAND_IDS.workbenchSetPrimaryMaterial, materialId);
    await services.commands.execute(COMMAND_IDS.libraryOpenBook, material);
    await waitFor(() => expect(screen.getByRole('toolbar', { name: /示例书/ })).toBeInTheDocument());
    await waitFor(() => expect(hosts[0]?.init).toHaveBeenCalled());
    const materialMenuButton = screen.getByRole('button', { name: '材料更多操作' });
    await user.click(materialMenuButton);
    await user.click(screen.getByRole('menuitem', { name: '查看本材料批注' }));

    const sidebar = screen.getByRole('dialog', { name: '材料批注面板' });
    expect(sidebar).toHaveTextContent('第一段重要原文');
    expect(sidebar).toHaveTextContent('第二段原文');
    expect(sidebar).toHaveTextContent('失联');
    expect(screen.getByRole('button', { name: '导出材料批注' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '导出材料批注' }));
    await waitFor(() => expect(exportWriter.writeMarkdown).toHaveBeenCalledOnce());
    expect(exportDestinationPicker.pickAnnotationExportDestination).toHaveBeenCalledWith(
      '示例书-批注.md',
    );
    expect(exportWriter.writeMarkdown).toHaveBeenCalledWith(
      'notes.md',
      expect.stringContaining('第一段重要原文'),
    );

    const search = screen.getByRole('searchbox', { name: '筛选批注' });
    await user.type(search, '需要回看');
    expect(sidebar).toHaveTextContent('第一段重要原文');
    expect(sidebar).not.toHaveTextContent('第二段原文');

    await user.clear(search);
    await user.click(screen.getByRole('button', { name: '跳转到批注 第一段重要原文' }));
    await waitFor(() => {
      expect(screen.getByRole('toolbar', { name: /示例书/ })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        hosts.some((host) =>
          vi.mocked(host.goToLocation).mock.calls.some(
            ([location]) => location === 'epubcfi(/6/4)!/4/2/2/1:0',
          ),
        ),
      ).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: '关闭材料批注面板' }));
    await waitFor(() => expect(document.activeElement).toBe(materialMenuButton));
  });

  it('生产书库树支持创建、取消、改名、重名校验、五层限制并在重启后恢复', async () => {
    const folderRepository = createInMemoryLibraryFolderRepository();
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    const user = userEvent.setup();
    const { unmount } = renderApp(services);

    await waitFor(() => expect(screen.getByRole('tree', { name: '书库文件夹树' })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '新建文件夹' }));
    await user.type(screen.getByRole('textbox', { name: '新建文件夹名称' }), '取消的文件夹');
    await user.keyboard('{Escape}');
    await expect(folderRepository.listFolders()).resolves.toEqual([]);

    await user.click(screen.getByRole('button', { name: '新建文件夹' }));
    await user.type(screen.getByRole('textbox', { name: '新建文件夹名称' }), '  文史  ');
    await user.keyboard('{Enter}');
    const root = await waitFor(async () => {
      const all = await folderRepository.listFolders();
      expect(all).toHaveLength(1);
      return all[0] as LibraryFolder;
    });
    expect(root.name).toBe('文史');

    await user.click(screen.getByRole('button', { name: '在“文史”中新建子文件夹' }));
    await user.type(screen.getByRole('textbox', { name: '新建子文件夹名称' }), '哲学');
    await user.keyboard('{Enter}');
    const child = await waitFor(async () => {
      const all = await folderRepository.listFolders();
      expect(all).toHaveLength(2);
      return all.find((folder) => folder.parentId === root.id) as LibraryFolder;
    });
    expect(child.name).toBe('哲学');

    await user.click(screen.getByRole('button', { name: '重命名 哲学' }));
    const renameInput = screen.getByRole('textbox', { name: '重命名文件夹' });
    await user.clear(renameInput);
    await user.type(renameInput, '思想史');
    await user.keyboard('{Enter}');
    await waitFor(async () => expect((await folderRepository.listFolders()).find((folder) => folder.id === child.id)?.name).toBe('思想史'));

    await user.click(screen.getByRole('button', { name: '新建文件夹' }));
    await user.type(screen.getByRole('textbox', { name: '新建文件夹名称' }), '文史');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('已有同名文件夹'));
    await user.keyboard('{Escape}');

    const chainIds = [root.id, child.id];
    let parentId = child.id;
    for (let depth = 3; depth <= 5; depth += 1) {
      const created = await services.commands.execute(
        COMMAND_IDS.libraryCreateFolder,
        `第${depth}层`,
        parentId,
      ) as LibraryFolder;
      parentId = created.id;
      chainIds.push(parentId);
    }
    for (const folderId of chainIds) {
      await services.commands.execute(COMMAND_IDS.workbenchSetLibraryFolderExpanded, folderId, true);
    }
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /新建子文件夹.*已达到最多五层/ })).toBeDisabled();
    });
    await expect(
      services.commands.execute(COMMAND_IDS.libraryCreateFolder, '第六层', parentId),
    ).rejects.toThrow('已达到最多五层');

    const persistedFolders = await folderRepository.listFolders();
    unmount();
    useLibraryStore.getState().resetToDefault();
    useWorkspaceStore.getState().resetToDefault();
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
    });
    renderApp(services);
    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /文史/ })).toBeInTheDocument();
      expect(screen.getByText('未归类')).toBeInTheDocument();
    });
    await expect(folderRepository.listFolders()).resolves.toEqual(persistedFolders);
  });

  it('材料默认未归类,可从材料菜单移动到文件夹并在回收站恢复后保留归属', async () => {
    const folderRepository = createInMemoryLibraryFolderRepository();
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    const user = userEvent.setup();
    renderApp(services);

    await waitFor(() => expect(screen.getByRole('tree', { name: '书库文件夹树' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '新建文件夹' }));
    await user.type(screen.getByRole('textbox', { name: '新建文件夹名称' }), '文史');
    await user.keyboard('{Enter}');
    const folder = await waitFor(async () => {
      const folders = await folderRepository.listFolders();
      expect(folders).toHaveLength(1);
      return folders[0] as LibraryFolder;
    });

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getAllByText('示例书').length).toBeGreaterThan(0));
    const material = useLibraryStore.getState().materials[0]!;
    expect(material.folderId).toBeNull();

    screen.getByRole('button', { name: /打开 示例书/ }).focus();
    await user.click(screen.getByRole('button', { name: '书库更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '移动到…' }));
    await user.click(screen.getByRole('menuitem', { name: '移动到 文史' }));

    await waitFor(() => {
      expect(useLibraryStore.getState().materials[0]?.folderId).toBe(folder.id);
    });
    expect(useLibraryStore.getState().materials[0]?.id).toBe(material.id);
    expect(screen.getByRole('treeitem', { name: /文史/ })).toHaveTextContent('示例书');

    await user.click(screen.getByRole('button', { name: /打开 示例书/ }));
    await waitFor(() => expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /打开 示例书/ }));
    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '书库更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '移入回收站' }));
    await waitFor(() => expect(useLibraryStore.getState().trashedMaterials).toHaveLength(1));
    expect(useLibraryStore.getState().trashedMaterials[0]?.folderId).toBe(folder.id);
    await user.click(screen.getByRole('button', { name: /回收站/ }));
    await user.click(screen.getByRole('button', { name: /恢复 示例书/ }));
    await waitFor(() => expect(useLibraryStore.getState().materials[0]?.folderId).toBe(folder.id));
  });

  it('桌面用户可拖动单本材料到文件夹,同归属放置无操作且重启后恢复', async () => {
    const folderRepository = createInMemoryLibraryFolderRepository();
    const folder = await folderRepository.createFolder('文史', null);
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    const execute = vi.spyOn(services.commands, 'execute');
    const { unmount } = renderApp(services);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getByRole('listitem', { name: '示例书' })).toBeInTheDocument());
    const source = screen.getByRole('listitem', { name: '示例书' });
    expect(source).toHaveAttribute('draggable', 'true');
    const folderTarget = screen.getByRole('treeitem', { name: '文件夹 文史' });
    expect(folderTarget).not.toHaveAttribute('draggable', 'true');
    const materialId = (await services.importRepository.listMaterials())[0]!.id;
    const transfer = createDataTransfer();
    writeLibraryMaterialDragPayload(transfer, materialId);

    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(folderTarget, { dataTransfer: transfer });
    expect(folderTarget).toHaveAttribute('data-drop-state', 'valid');
    expect(folderTarget).toHaveTextContent('放置到这里');
    fireEvent.drop(folderTarget, { dataTransfer: transfer });

    await waitFor(async () => {
      expect((await services.importRepository.listMaterials())[0]?.folderId).toBe(folder.id);
    });
    expect(execute).toHaveBeenCalledWith(
      COMMAND_IDS.libraryMoveMaterial,
      materialId,
      folder.id,
    );
    await waitFor(() => expect(folderTarget).not.toHaveAttribute('data-drop-state'));

    const movedSource = screen.getByRole('treeitem', { name: '示例书' });
    const callsBeforeSameTarget = execute.mock.calls.filter(
      ([commandId]) => commandId === COMMAND_IDS.libraryMoveMaterial,
    ).length;
    const sameTargetTransfer = createDataTransfer();
    writeLibraryMaterialDragPayload(sameTargetTransfer, materialId);
    fireEvent.dragStart(movedSource, { dataTransfer: sameTargetTransfer });
    fireEvent.dragOver(folderTarget, { dataTransfer: sameTargetTransfer });
    expect(folderTarget).toHaveAttribute('data-drop-state', 'same');
    expect(folderTarget).toHaveTextContent('已在此处');
    fireEvent.drop(folderTarget, { dataTransfer: sameTargetTransfer });
    await waitFor(() => expect(folderTarget).not.toHaveAttribute('data-drop-state'));
    expect(
      execute.mock.calls.filter(([commandId]) => commandId === COMMAND_IDS.libraryMoveMaterial),
    ).toHaveLength(callsBeforeSameTarget);

    const importRepository = services.importRepository;
    const filePicker = services.filePicker;
    unmount();
    useLibraryStore.getState().resetToDefault();
    useWorkspaceStore.getState().resetToDefault();
    services = createAppServices({
      workspaceRepository: repository,
      importRepository,
      filePicker,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    renderApp(services);

    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: '文件夹 文史' })).toHaveTextContent('示例书');
    });
    expect((await services.importRepository.listMaterials())[0]?.folderId).toBe(folder.id);
  });

  it('混合指针设备仍允许使用精确鼠标拖动材料', async () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(pointer: coarse)' || query === '(any-pointer: fine)',
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList),
    });
    try {
      const { unmount } = renderApp(services);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
      await waitFor(() => expect(screen.getByRole('listitem', { name: '示例书' })).toBeInTheDocument());

      expect(screen.getByRole('listitem', { name: '示例书' })).toHaveAttribute('draggable', 'true');
      unmount();
    } finally {
      if (previousMatchMedia) {
        Object.defineProperty(window, 'matchMedia', {
          configurable: true,
          value: previousMatchMedia,
        });
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
    }
  });

  it('浏览器未报告精确指针时仍可用鼠标拖到文件夹', async () => {
    const previousMatchMedia = window.matchMedia;
    const previousElementFromPoint = document.elementFromPoint;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList),
    });
    const folderRepository = createInMemoryLibraryFolderRepository();
    const folder = await folderRepository.createFolder('文史', null);
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    try {
      const { unmount } = renderApp(services);
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
      await waitFor(() => expect(screen.getByRole('listitem', { name: '示例书' })).toBeInTheDocument());

      const source = screen.getByRole('listitem', { name: '示例书' });
      const folderTarget = screen.getByRole('treeitem', { name: '文件夹 文史' });
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: () => folderTarget,
      });
      fireEvent.pointerDown(source, {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 100,
        clientY: 300,
      });
      fireEvent.pointerMove(window, {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 200,
        clientY: 150,
      });
      expect(folderTarget).toHaveAttribute('data-drop-state', 'valid');
      fireEvent.pointerUp(window, {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 200,
        clientY: 150,
      });
      await waitFor(async () => {
        expect((await services.importRepository.listMaterials())[0]?.folderId).toBe(folder.id);
      });
      unmount();
    } finally {
      if (previousElementFromPoint) {
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          value: previousElementFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, 'elementFromPoint');
      }
      if (previousMatchMedia) {
        Object.defineProperty(window, 'matchMedia', {
          configurable: true,
          value: previousMatchMedia,
        });
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
    }
  });

  it('鼠标指针拖动到文件夹空白区域时完成材料归类', async () => {
    const folderRepository = createInMemoryLibraryFolderRepository();
    const folder = await folderRepository.createFolder('文史', null);
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    const { unmount } = renderApp(services);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getByRole('listitem', { name: '示例书' })).toBeInTheDocument());

    const source = screen.getByRole('listitem', { name: '示例书' });
    const folderTarget = screen.getByRole('treeitem', { name: '文件夹 文史' });
    const previousElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => folderTarget,
    });
    try {
      fireEvent.pointerDown(source, {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 100,
        clientY: 300,
      });
      fireEvent.pointerMove(window, {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 200,
        clientY: 150,
      });

      expect(folderTarget).toHaveAttribute('data-drop-state', 'valid');
      fireEvent.pointerUp(window, {
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 200,
        clientY: 150,
      });
      await waitFor(async () => {
        expect((await services.importRepository.listMaterials())[0]?.folderId).toBe(folder.id);
      });
    } finally {
      if (previousElementFromPoint) {
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          value: previousElementFromPoint,
        });
      } else {
        Reflect.deleteProperty(document, 'elementFromPoint');
      }
      unmount();
    }
  });

  it('拖到未归类复用移动 Command,非法拖拽不产生副作用', async () => {
    const folderRepository = createInMemoryLibraryFolderRepository();
    const folder = await folderRepository.createFolder('文史', null);
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    const execute = vi.spyOn(services.commands, 'execute');
    const { unmount } = renderApp(services);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getByRole('listitem', { name: '示例书' })).toBeInTheDocument());

    const materialId = (await services.importRepository.listMaterials())[0]!.id;
    const source = screen.getByRole('listitem', { name: '示例书' });
    const folderTarget = screen.getByRole('treeitem', { name: '文件夹 文史' });
    const toFolder = createDataTransfer();
    writeLibraryMaterialDragPayload(toFolder, materialId);
    fireEvent.dragStart(source, { dataTransfer: toFolder });
    fireEvent.drop(folderTarget, { dataTransfer: toFolder });
    await waitFor(async () => {
      expect((await services.importRepository.listMaterials())[0]?.folderId).toBe(folder.id);
    });

    const unfiledTarget = screen
      .getByRole('button', { name: '收起未归类材料' })
      .closest<HTMLElement>('[data-library-drop-target="unfiled"]');
    expect(unfiledTarget).not.toBeNull();
    const movedSource = screen.getByRole('treeitem', { name: '示例书' });
    const toUnfiled = createDataTransfer();
    writeLibraryMaterialDragPayload(toUnfiled, materialId);
    fireEvent.dragStart(movedSource, { dataTransfer: toUnfiled });
    fireEvent.dragOver(unfiledTarget!, { dataTransfer: toUnfiled });
    expect(unfiledTarget).toHaveAttribute('data-drop-state', 'valid');
    fireEvent.drop(unfiledTarget!, { dataTransfer: toUnfiled });
    await waitFor(async () => {
      expect((await services.importRepository.listMaterials())[0]?.folderId).toBeNull();
    });
    expect(execute).toHaveBeenCalledWith(COMMAND_IDS.libraryMoveMaterial, materialId, null);

    const invalidTransfer = createDataTransfer();
    invalidTransfer.setData(
      LIBRARY_MATERIAL_DRAG_TYPE,
      JSON.stringify({ materialIds: [materialId, 'another-material'] }),
    );
    fireEvent.dragEnter(folderTarget, { dataTransfer: invalidTransfer });
    fireEvent.dragOver(folderTarget, { dataTransfer: invalidTransfer });
    expect(folderTarget).toHaveAttribute('data-drop-state', 'invalid');
    expect(folderTarget).toHaveTextContent('仅支持单本材料');
    const moveCalls = execute.mock.calls.filter(
      ([commandId]) => commandId === COMMAND_IDS.libraryMoveMaterial,
    ).length;
    fireEvent.drop(folderTarget, { dataTransfer: invalidTransfer });
    await waitFor(() => expect(folderTarget).not.toHaveAttribute('data-drop-state'));
    expect(
      execute.mock.calls.filter(([commandId]) => commandId === COMMAND_IDS.libraryMoveMaterial),
    ).toHaveLength(moveCalls);
    expect((await services.importRepository.listMaterials())[0]?.folderId).toBeNull();

    const nonTargetMaterial = screen.getByRole('listitem', { name: '示例书' });
    fireEvent.dragEnter(nonTargetMaterial, { dataTransfer: invalidTransfer });
    fireEvent.dragOver(nonTargetMaterial, { dataTransfer: invalidTransfer });
    expect(nonTargetMaterial).toHaveAttribute('data-drop-state', 'invalid');
    expect(nonTargetMaterial).toHaveTextContent('仅支持单本材料');
    fireEvent.drop(nonTargetMaterial, { dataTransfer: invalidTransfer });
    expect(nonTargetMaterial).not.toHaveAttribute('data-drop-state');

    const mixedFileTransfer = createDataTransfer();
    writeLibraryMaterialDragPayload(mixedFileTransfer, materialId);
    Object.defineProperty(mixedFileTransfer, 'files', {
      configurable: true,
      value: [new File(['外部文件'], '外部文件.txt')],
    });
    fireEvent.dragOver(folderTarget, { dataTransfer: mixedFileTransfer });
    expect(folderTarget).toHaveAttribute('data-drop-state', 'invalid');
    fireEvent.drop(folderTarget, { dataTransfer: mixedFileTransfer });
    expect(folderTarget).not.toHaveAttribute('data-drop-state');

    const cancelTransfer = createDataTransfer();
    writeLibraryMaterialDragPayload(cancelTransfer, materialId);
    const currentSource = screen.getByRole('listitem', { name: '示例书' });
    fireEvent.dragStart(currentSource, { dataTransfer: cancelTransfer });
    fireEvent.dragOver(folderTarget, { dataTransfer: cancelTransfer });
    expect(folderTarget).toHaveAttribute('data-drop-state', 'valid');
    fireEvent.dragEnd(currentSource);
    expect(folderTarget).not.toHaveAttribute('data-drop-state');

    unmount();
  });

  it('拖拽移动的平台失败时保留原归属并清理放置反馈', async () => {
    const folderRepository = createInMemoryLibraryFolderRepository();
    await folderRepository.createFolder('文史', null);
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    vi.spyOn(services.importRepository, 'moveMaterialToFolder').mockRejectedValueOnce(
      new Error('模拟平台写入失败'),
    );
    renderApp(services);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getByRole('listitem', { name: '示例书' })).toBeInTheDocument());

    const materialId = (await services.importRepository.listMaterials())[0]!.id;
    const source = screen.getByRole('listitem', { name: '示例书' });
    const folderTarget = screen.getByRole('treeitem', { name: '文件夹 文史' });
    const transfer = createDataTransfer();
    writeLibraryMaterialDragPayload(transfer, materialId);
    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.drop(folderTarget, { dataTransfer: transfer });

    await waitFor(() => {
      expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent('移动材料失败:模拟平台写入失败');
    });
    expect((await services.importRepository.listMaterials())[0]?.folderId).toBeNull();
    expect(folderTarget).not.toHaveAttribute('data-drop-state');
  });

  it('拖动期间文件夹失效时拒绝放置并保留原归属', async () => {
    const folderRepository = createInMemoryLibraryFolderRepository();
    const folder = await folderRepository.createFolder('文史', null);
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    renderApp(services);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getByRole('listitem', { name: '示例书' })).toBeInTheDocument());

    const materialId = (await services.importRepository.listMaterials())[0]!.id;
    const source = screen.getByRole('listitem', { name: '示例书' });
    const folderTarget = screen.getByRole('treeitem', { name: '文件夹 文史' });
    const transfer = createDataTransfer();
    writeLibraryMaterialDragPayload(transfer, materialId);
    fireEvent.dragStart(source, { dataTransfer: transfer });
    await folderRepository.deleteFolder(folder.id);
    fireEvent.drop(folderTarget, { dataTransfer: transfer });

    await waitFor(() => {
      expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(
        '移动材料失败:目标文件夹不存在,请刷新书库后重试',
      );
    });
    expect((await services.importRepository.listMaterials())[0]?.folderId).toBeNull();
    expect(folderTarget).not.toHaveAttribute('data-drop-state');
  });

  it('删除文件夹前明确确认,取消不变更,确认后递归移除并保留打开材料', async () => {
    services = createAppServices({
      workspaceRepository: repository,
      viewHostFactory: () => createFakeViewHost(),
    });
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '新建文件夹' }));
    await user.type(screen.getByRole('textbox', { name: '新建文件夹名称' }), '待删除');
    await user.keyboard('{Enter}');
    const folder = await waitFor(async () => {
      const folders = await services.libraryFolderRepository.listFolders();
      expect(folders).toHaveLength(1);
      return folders[0] as LibraryFolder;
    });

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getAllByText('示例书').length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: '打开 示例书' }));
    await waitFor(() => expect(useWorkspaceStore.getState().editorGroups[0]?.views).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: '书库更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '移动到…' }));
    await user.click(screen.getByRole('menuitem', { name: '移动到 待删除' }));
    await waitFor(() => expect(useLibraryStore.getState().materials[0]?.folderId).toBe(folder.id));
    await services.commands.execute(COMMAND_IDS.workbenchSetLibraryFolderExpanded, folder.id, true);

    await user.click(screen.getByRole('button', { name: '删除 待删除' }));
    const dialog = screen.getByRole('dialog', { name: '删除书库文件夹' });
    expect(dialog).toHaveTextContent('子文件夹结构将无法恢复');
    expect(dialog).toHaveTextContent('书籍会转为未归类');
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(await services.libraryFolderRepository.listFolders()).toHaveLength(1);
    expect(useLibraryStore.getState().materials[0]?.folderId).toBe(folder.id);

    await user.click(screen.getByRole('button', { name: '删除 待删除' }));
    await user.click(screen.getByRole('button', { name: '删除文件夹' }));
    await waitFor(async () => {
      expect(await services.libraryFolderRepository.listFolders()).toEqual([]);
      expect(useLibraryStore.getState().materials[0]?.folderId).toBeNull();
    });
    expect(screen.getByText('未归类')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开 示例书' })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().editorGroups[0]?.views).toHaveLength(1);
    expect(useWorkspaceStore.getState().expandedLibraryFolderIds).toEqual([]);
  });

  it('应用级覆盖五层子树、回收站材料与重启恢复', async () => {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, 'active.md', new TextEncoder().encode('# 活跃材料'));
    addInMemorySource(sources, 'trashed.md', new TextEncoder().encode('# 回收站材料'));
    const importRepository = createInMemoryImportRepository(sources);
    const folderRepository = createInMemoryLibraryFolderRepository([], {
      prepareDeleteSubtree: (folderIds) =>
        importRepository.prepareClearMaterialFolderAssignments(folderIds),
    });
    const root = await folderRepository.createFolder('五层删除根', null);
    const folderIds = [root.id];
    let parentId = root.id;
    for (let depth = 2; depth <= 5; depth += 1) {
      const folder = await folderRepository.createFolder(`第${depth}层`, parentId);
      folderIds.push(folder.id);
      parentId = folder.id;
    }
    const activeStaged = await importRepository.stageImport('active.md');
    const active = await importRepository.commitImport(activeStaged, {
      title: '活跃材料',
      author: '作者甲',
      language: 'zh',
    });
    const trashedStaged = await importRepository.stageImport('trashed.md');
    const trashed = await importRepository.commitImport(trashedStaged, {
      title: '回收站材料',
      author: '作者乙',
      language: 'zh',
    });
    await importRepository.moveMaterialToFolder(active.id, parentId);
    await importRepository.moveMaterialToFolder(trashed.id, parentId);
    const trashedMaterial = await importRepository.trashMaterial(trashed.id);

    services = createAppServices({
      workspaceRepository: repository,
      importRepository,
      filePicker: createInMemoryFilePicker([]),
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    const user = userEvent.setup();
    const { unmount } = renderApp(services);
    await waitFor(() => expect(screen.getByRole('tree', { name: '书库文件夹树' })).toBeInTheDocument());
    for (const folderId of folderIds) {
      await services.commands.execute(COMMAND_IDS.workbenchSetLibraryFolderExpanded, folderId, true);
    }
    await user.click(screen.getByRole('button', { name: '打开 活跃材料' }));
    await waitFor(() => expect(useWorkspaceStore.getState().editorGroups[0]?.views).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: '删除 五层删除根' }));
    await user.click(screen.getByRole('button', { name: '删除文件夹' }));
    await waitFor(async () => expect(await folderRepository.listFolders()).toEqual([]));
    expect((await importRepository.listMaterials())[0]?.folderId).toBeNull();
    expect((await importRepository.listTrashed())[0]?.folderId).toBeNull();
    expect(useWorkspaceStore.getState().editorGroups[0]?.views).toHaveLength(1);

    unmount();
    useLibraryStore.getState().resetToDefault();
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.getState().closeAll();
    services = createAppServices({
      workspaceRepository: repository,
      importRepository,
      filePicker: createInMemoryFilePicker([]),
      libraryFolderRepository: folderRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    renderApp(services);
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: /五层删除根/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '打开 活跃材料' })).toBeInTheDocument();
    });
    expect((await importRepository.listTrashed())[0]).toMatchObject({
      id: trashedMaterial.id,
      folderId: null,
    });
    expect((await repository.loadState()).expandedLibraryFolderIds).toEqual([]);
  });

  it('应用级文件夹删除失败时保留结构并显示中文错误', async () => {
    const folder: LibraryFolder = { id: 'failed-folder', name: '失败目标', parentId: null };
    const folderRepository = createInMemoryLibraryFolderRepository([folder]);
    vi.spyOn(folderRepository, 'deleteFolder').mockRejectedValue(
      new Error('数据库约束失败,请重试'),
    );
    services = createAppServices({
      workspaceRepository: repository,
      libraryFolderRepository: folderRepository,
    });
    const user = userEvent.setup();
    renderApp(services);
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /失败目标/ })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '删除 失败目标' }));
    await user.click(screen.getByRole('button', { name: '删除文件夹' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('数据库约束失败,请重试'));
    expect(await folderRepository.listFolders()).toEqual([folder]);
    expect(screen.getByRole('treeitem', { name: /失败目标/ })).toBeInTheDocument();
  });

  it('材料批注覆盖面板关闭后焦点归还且不写入工作区状态', async () => {
    const user = userEvent.setup();
    renderApp(services);

    const opener = screen.getByRole('button', { name: '书库' });
    opener.focus();
    useShellUiStore.getState().openAnnotationPanel('missing-material');
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: '材料批注面板' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: '关闭材料批注面板' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '材料批注面板' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
    await expect(repository.loadState()).resolves.toEqual(DEFAULT_WORKSPACE_STATE);
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
      expect(screen.getAllByText('示例书').length).toBeGreaterThan(0);
    });
    screen.getByRole('button', { name: /打开 示例书/ }).focus();
    await user.click(screen.getByRole('button', { name: '书库更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '移入回收站' }));
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
      expect(screen.getAllByText('示例书').length).toBeGreaterThan(0);
    });

    screen.getByRole('button', { name: /打开 示例书/ }).focus();
    await user.click(screen.getByRole('button', { name: '书库更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '移入回收站' }));

    await waitFor(() => {
      expect(screen.queryByText('示例书')).not.toBeInTheDocument();
    });
    expect(useLibraryStore.getState().materials).toHaveLength(0);
    expect(useLibraryStore.getState().trashedMaterials).toHaveLength(1);
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(/已移入回收站/);
  });

  it('未归类区固定显示在回收站上方', async () => {
    const user = userEvent.setup();
    await importAndOpenTrash(user);

    const unfiledToggle = screen.getByRole('button', { name: '收起未归类材料' });
    const trashToggle = screen.getByRole('button', { name: /回收站/ });
    expect(unfiledToggle.compareDocumentPosition(trashToggle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('从回收站恢复后重新回到活跃书库', async () => {
    const user = userEvent.setup();
    await importAndOpenTrash(user);
    await waitFor(() => {
      expect(screen.getByLabelText(`永久删除 示例书`)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /恢复 示例书/ }));

    await waitFor(() => {
      expect(screen.getAllByText('示例书').length).toBeGreaterThan(0);
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

  it('从书库打开一本书后会新增阅读区,拆分与关闭入口位于材料更多操作', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });

    await user.click(openButton);

    await waitFor(() => {
      expect(screen.getByRole('toolbar', { name: /示例书/ })).toBeInTheDocument();
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });
    const readingToolbar = screen.getByRole('toolbar', { name: /示例书/ });
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(within(readingToolbar).getByRole('button', { name: '阅读排版' })).toBeInTheDocument();
    expect(within(readingToolbar).queryByRole('button', { name: '向右拆分编辑器组' })).not.toBeInTheDocument();

    await user.click(within(readingToolbar).getByRole('button', { name: '材料更多操作' }));
    expect(screen.getByRole('menu', { name: '材料更多操作菜单' })).toHaveTextContent('向右拆分编辑器组');
    expect(screen.getByRole('menu', { name: '材料更多操作菜单' })).toHaveTextContent('向下拆分编辑器组');
    await user.click(screen.getByRole('menuitem', { name: '向右拆分编辑器组' }));

    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups).toHaveLength(2);
      expect(screen.getAllByRole('toolbar', { name: /示例书/ })).toHaveLength(2);
    });
    const closeSplitButtons = screen.getAllByRole('button', { name: '关闭当前拆分区' });
    expect(closeSplitButtons).toHaveLength(2);
    await user.click(closeSplitButtons[1]!);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups).toHaveLength(1);
      expect(screen.queryByRole('button', { name: '关闭当前拆分区' })).not.toBeInTheDocument();
    });

    await user.click(openButton);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
      expect(screen.getAllByRole('toolbar', { name: /示例书/ })).toHaveLength(1);
    });
  });

  it('界面面板的书籍范围通过生产 Command 持久化 EPUB 排版并更新有效值', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });
    await user.click(openButton);
    await waitFor(() => expect(useWorkspaceStore.getState().editorGroups[0]?.views).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: '界面' }));
    const panel = await screen.findByRole('complementary', { name: '界面侧栏' });
    const booksScope = within(panel).getByRole('region', { name: '书籍' });
    expect(booksScope).toHaveTextContent('示例书');
    expect(booksScope).toHaveTextContent('跟随全局默认');

    await user.click(within(booksScope).getByRole('button', { name: '护眼' }));
    await waitFor(() => {
      expect(booksScope).toHaveTextContent('材料级覆盖');
      expect(booksScope).toHaveTextContent('护眼');
    });
    await expect(repository.loadState()).resolves.toMatchObject({
      materialTypography: {
        [useLibraryStore.getState().materials[0]!.id]: { theme: 'sepia' },
      },
    });

    await user.click(within(booksScope).getByRole('button', { name: '恢复默认阅读排版' }));
    await waitFor(() => expect(booksScope).toHaveTextContent('跟随全局默认'));
    expect(useWorkspaceStore.getState().globalReadingTypography.theme).toBe('light');
    await expect(repository.loadState()).resolves.toMatchObject({ materialTypography: {} });
  });

  it('材料更多操作支持编辑书名并将当前材料移入回收站', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });
    await user.click(openButton);

    const readingToolbar = await screen.findByRole('toolbar', { name: /示例书/ });
    await user.click(within(readingToolbar).getByRole('button', { name: '材料更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑元数据' }));

    const metadataDialog = screen.getByRole('dialog', { name: '编辑 示例书 的元数据' });
    const titleInput = within(metadataDialog).getAllByRole('textbox')[0]!;
    await user.clear(titleInput);
    await user.type(titleInput, '整理后的书名');
    await user.click(within(metadataDialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(useLibraryStore.getState().materials[0]?.title).toBe('整理后的书名');
      expect(screen.getByRole('toolbar', { name: /整理后的书名/ })).toBeInTheDocument();
    });

    const updatedToolbar = screen.getByRole('toolbar', { name: /整理后的书名/ });
    await user.click(within(updatedToolbar).getByRole('button', { name: '材料更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '移入回收站' }));

    await waitFor(() => {
      expect(useLibraryStore.getState().materials).toHaveLength(0);
      expect(useLibraryStore.getState().trashedMaterials).toHaveLength(1);
      expect(useLibraryStore.getState().trashedMaterials[0]?.title).toBe('整理后的书名');
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
      tocVisible: workspace.tocVisible,
      interfacePanelVisible: workspace.interfacePanelVisible,
      activityPanelWidth: workspace.activityPanelWidth,
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

  it('工作台不在常驻工具栏显示阅读位置前进/后退按钮', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });
    await user.click(openButton);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });

    expect(screen.queryByRole('button', { name: '应用后退' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '应用前进' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '后退' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '前进' })).not.toBeInTheDocument();
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
      tocVisible: workspace.tocVisible,
      interfacePanelVisible: workspace.interfacePanelVisible,
      activityPanelWidth: workspace.activityPanelWidth,
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

    const toggle = screen.getByRole('button', { name: '目录' });
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
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['app-test-cover'], { type: 'image/png' }));
    });
  });

  it('导入固定版式 PDF 后可从书库打开并创建阅读标签', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => {
      expect(screen.getAllByText('示例 PDF').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(/已导入 1 份文件/);

    const openButton = await screen.findByRole('button', { name: /打开 示例 PDF/ });
    await user.click(openButton);

    await waitFor(() => {
      expect(screen.getByRole('toolbar', { name: /示例 PDF/ })).toBeInTheDocument();
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    });
  });

  it('界面面板的 PDF 书籍范围把页面适配和缩放保留在当前 ReadingView', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getAllByText('示例 PDF').length).toBeGreaterThan(0));
    await user.click(await screen.findByRole('button', { name: /打开 示例 PDF/ }));
    await waitFor(() => expect(screen.getByRole('toolbar', { name: /示例 PDF/ })).toBeInTheDocument());

    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    await waitFor(() => expect(useReaderRuntime.getState().getDocument(viewId)?.getCurrentIndex()).toBe(1));
    const materialId = useLibraryStore.getState().materials[0]!.id;
    await user.click(screen.getByRole('button', { name: '界面' }));
    const booksScope = within(
      await screen.findByRole('complementary', { name: '界面侧栏' }),
    ).getByRole('region', { name: '书籍' });

    await user.click(within(booksScope).getByRole('button', { name: '整页' }));
    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location).toMatchObject({
        kind: 'pdf',
        fit: 'page',
      });
    });
    fireEvent.change(within(booksScope).getByRole('slider', { name: '缩放' }), {
      target: { value: '150' },
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.location).toMatchObject({
        kind: 'pdf',
        zoom: 150,
      });
    });
    expect(useWorkspaceStore.getState().materialTypography[materialId]).toBeUndefined();
    expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id).toBe(viewId);
  });

  it('PDF 分页正文左右点击经当前 ReadingView 作用域到前后页 Command', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    await waitFor(() => expect(screen.getAllByText('示例 PDF').length).toBeGreaterThan(0));
    await user.click(await screen.findByRole('button', { name: /打开 示例 PDF/ }));
    await waitFor(() => expect(screen.getByRole('toolbar', { name: /示例 PDF/ })).toBeInTheDocument());

    const viewId = useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
    const book = useReaderRuntime.getState().getDocument(viewId)!;
    const content = document.querySelector<HTMLElement>(`[data-view-id="${viewId}"]`)!;
    await waitFor(() => expect(book.getCurrentIndex()).toBe(1));

    fireEvent.click(content, { clientX: 900, clientY: 320 });
    await waitFor(() => expect(book.getCurrentIndex()).toBe(2));

    fireEvent.click(content, { clientX: 450, clientY: 320 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(book.getCurrentIndex()).toBe(2);

    fireEvent.click(content, { clientX: 100, clientY: 320 });
    await waitFor(() => expect(book.getCurrentIndex()).toBe(1));
    fireEvent.click(content, { clientX: 100, clientY: 320 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(book.getCurrentIndex()).toBe(1);

    fireEvent.click(content, { clientX: 900, clientY: 320 });
    await waitFor(() => expect(book.getCurrentIndex()).toBe(2));
    fireEvent.click(content, { clientX: 900, clientY: 320 });
    await waitFor(() => expect(book.getCurrentIndex()).toBe(3));
    fireEvent.click(content, { clientX: 900, clientY: 320 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(book.getCurrentIndex()).toBe(3);

    fireEvent.click(screen.getByRole('button', { name: '阅读排版' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(book.getCurrentIndex()).toBe(3);
  });

  it('PDF 首页封面失败时仍进入书库并在状态栏报告封面降级', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(null);
    });
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));

    await waitFor(() => {
      expect(screen.getAllByText('示例 PDF').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent(/封面降级/);
    expect(screen.getByRole('status', { name: '状态栏' })).toHaveTextContent('示例PDF.pdf');
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
    await waitFor(() => expect(screen.getAllByText('示例 PDF').length).toBeGreaterThan(0));
    await user.click(await screen.findByRole('button', { name: /打开 示例 PDF/ }));
    await waitFor(() => expect(screen.getByRole('toolbar', { name: /示例 PDF/ })).toBeInTheDocument());

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
