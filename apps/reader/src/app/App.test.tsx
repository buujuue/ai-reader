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
import { createInMemoryFilePicker } from './filePicker';
import {
  makeFakeDocument,
  makeFakeLib,
  makeFakeRasterizer,
} from '../domain/reader/pdf/pdfTestFakes';
import type { FoliateViewHost } from '../domain/reader/viewHost';
import { createAppServices, type AppServices } from './bootstrap';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { useReaderRuntime } from '../workbench/readerRuntime';
import { useLibraryStore } from '../workbench/libraryStore';
import { App } from './App';
import { AppServicesProvider } from './AppServicesContext';

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
  };
}

describe('阅读工作台外壳', () => {
  let repository: WorkspaceRepository;
  let services: AppServices;

  beforeEach(() => {
    repository = createInMemoryWorkspaceRepository();
    services = createAppServices({ workspaceRepository: repository });
    useWorkspaceStore.getState().resetToDefault();
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

  it('从书库打开一本书后会新增阅读标签', async () => {
    const user = userEvent.setup();
    renderApp(services);

    await user.click(screen.getByRole('button', { name: '导入 EPUB' }));
    const openButton = await screen.findByRole('button', { name: /打开 示例书/ });

    await user.click(openButton);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /示例书/ })).toBeInTheDocument();
      expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
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
});