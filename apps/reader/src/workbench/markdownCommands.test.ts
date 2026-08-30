import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_IDS, CommandRegistry } from '../commands/commandRegistry';
import {
  addInMemorySource,
  createInMemoryImportRepository,
} from '../domain/library/inMemoryImportRepository';
import type { FoliateViewHost } from '../domain/reader/viewHost';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import {
  invalidateReaderRuntimeMaterial,
  reloadMaterialViews,
  registerReaderCommands,
  restoreReaderViewRuntime,
  suspendReaderViewRuntime,
} from './readerCommands';
import { ReaderRuntimeCache } from './readerRuntimeCache';
import { useLibraryStore } from './libraryStore';
import { useMarkdownSessionStore } from './markdownSessionStore';
import { registerMarkdownCommands } from './markdownCommands';
import { useReaderRuntime } from './readerRuntime';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';

async function readManagedText(
  repository: ReturnType<typeof createInMemoryImportRepository>,
  materialId: string,
): Promise<string> {
  const source = await repository.openManagedFileSource(materialId);
  return source.text();
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

const MARKDOWN_SOURCE = '# 我的笔记\n\n正文内容';

describe('Markdown 命令', () => {
  let registry: CommandRegistry;
  let importRepository: ReturnType<typeof createInMemoryImportRepository>;
  let workspaceRepository: ReturnType<typeof createInMemoryWorkspaceRepository>;
  let materialId: string;
  let readerRuntimeCache: ReaderRuntimeCache;

  async function setupWithMarkdown() {
    const sources = new Map<string, Uint8Array>();
    addInMemorySource(sources, '演示书/笔记.md', new TextEncoder().encode(MARKDOWN_SOURCE));
    importRepository = createInMemoryImportRepository(sources);
    const staged = await importRepository.stageImport('演示书/笔记.md');
    const bytes = await importRepository.readStagedFile(staged);
    const { inspectMarkdown } = await import('../domain/reader/markdown/markdownInspector');
    const { metadata } = await inspectMarkdown(bytes, '笔记.md');
    const material = await importRepository.commitImport(staged, metadata);
    materialId = material.id;
    return material;
  }

  beforeEach(async () => {
    registry = new CommandRegistry();
    workspaceRepository = createInMemoryWorkspaceRepository();
    readerRuntimeCache = new ReaderRuntimeCache();
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
    useMarkdownSessionStore.getState().resetToDefault();
    useShellUiStore.setState({
      markdownDirtyCloseViewId: null,
      markdownDirtyCloseAction: null,
      markdownRecoverySnapshots: [],
    });
    const material = await setupWithMarkdown();
    useLibraryStore.setState({ materials: [material], trashedMaterials: [] });
    const readerDependencies = {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
      readerRuntimeCache,
    };
    registerReaderCommands(registry, readerDependencies);
    // 注册 reader 命令后,再注册 markdown 命令(依赖 readerCloseView)。
    registerMarkdownCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
      invalidateMaterialRuntime: invalidateReaderRuntimeMaterial,
      reloadMaterialViews: (id) => reloadMaterialViews(readerDependencies, id),
      suspendReaderView: (id) => suspendReaderViewRuntime(readerDependencies, id),
      restoreReaderView: (id) =>
        restoreReaderViewRuntime(readerDependencies, id).then(() => undefined),
    });
    await registry.execute(COMMAND_IDS.libraryOpenBook, material);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function activeViewId(): string {
    return useWorkspaceStore.getState().editorGroups[0]!.views[0]!.id;
  }

  it('进入源码模式后视图 sourceMode 置为 true', async () => {
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);

    await registry.execute(COMMAND_IDS.markdownToggleSourceMode, activeViewId());

    const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
    expect(view.sourceMode).toBe(true);
  });

  it('退出源码模式时若会话脏则弹出脏文档确认而不直接退出', async () => {
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    await registry.execute(COMMAND_IDS.markdownToggleSourceMode, activeViewId());
    useMarkdownSessionStore.getState().updateText(materialId, '# 修改');

    await registry.execute(COMMAND_IDS.markdownToggleSourceMode, activeViewId());

    const view = useWorkspaceStore.getState().editorGroups[0]!.views[0]!;
    expect(view.sourceMode).toBe(true);
    expect(useShellUiStore.getState().markdownDirtyCloseViewId).toBe(activeViewId());
    expect(useShellUiStore.getState().markdownDirtyCloseAction).toBe('exitSource');
  });

  it('源码模式挂起 Markdown Runtime,编辑后失效旧正文,放弃修改可从共享会话重建', async () => {
    const original = useReaderRuntime.getState().getDocument(activeViewId())!;
    const close = vi.spyOn(original, 'close');
    // 应用级 ReadingView 会在这里完成首次挂载;命令测试显式调用同一公共挂载 seam。
    const { mountViewDocument } = await import('./readerCommands');
    mountViewDocument(original, activeViewId(), document.createElement('div'), null, {
      importRepository,
      workspaceRepository,
    });
    await vi.waitFor(() => expect(original.isRuntimeReady?.()).toBe(true));

    await registry.execute(COMMAND_IDS.markdownToggleSourceMode, activeViewId());
    expect(useReaderRuntime.getState().getDocumentLifecycle(activeViewId())).toBe('suspended');

    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 编辑中的正文');
    expect(close).toHaveBeenCalledOnce();
    expect(useReaderRuntime.getState().getDocument(activeViewId())).toBeUndefined();
    expect(readerRuntimeCache.getEntries()).toHaveLength(0);

    await registry.execute(COMMAND_IDS.markdownToggleSourceMode, activeViewId());
    expect(useShellUiStore.getState().markdownDirtyCloseAction).toBe('exitSource');
    await registry.execute(COMMAND_IDS.markdownCloseDirty, activeViewId(), 'discard');

    const rebuilt = useReaderRuntime.getState().getDocument(activeViewId());
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(original);
    expect(useWorkspaceStore.getState().editorGroups[0]!.views[0]!.sourceMode).toBe(false);
    expect(useMarkdownSessionStore.getState().getSession(materialId)).toMatchObject({
      text: MARKDOWN_SOURCE,
      dirty: false,
    });
  });

  it('保存命令由 importRepository 原子保存并递增版本、更新指纹', async () => {
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    useMarkdownSessionStore.getState().updateText(materialId, '# 新内容');
    const originalFingerprint = useLibraryStore.getState().materials[0]!.fingerprint;

    await registry.execute(COMMAND_IDS.markdownSave, activeViewId());

    const session = useMarkdownSessionStore.getState().getSession(materialId);
    expect(session?.dirty).toBe(false);
    expect(session?.savedVersion).toBe(1);
    const material = useLibraryStore.getState().materials.find((m) => m.id === materialId)!;
    expect(material.documentVersion).toBe(1);
    expect(material.fingerprint).not.toBe(originalFingerprint);
    // 托管文件已写入新内容。
    expect(await readManagedText(importRepository, materialId)).toBe('# 新内容');
  });

  it('正式保存使活动 Markdown Runtime 失效并按共享缓冲区重建', async () => {
    const before = useReaderRuntime.getState().getDocument(activeViewId())!;
    const close = vi.spyOn(before, 'close');
    useMarkdownSessionStore.getState().updateText(materialId, '# 保存后的正文');

    await registry.execute(COMMAND_IDS.markdownSave, activeViewId());

    const after = useReaderRuntime.getState().getDocument(activeViewId());
    expect(close).toHaveBeenCalledOnce();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(useMarkdownSessionStore.getState().getSession(materialId)).toMatchObject({
      text: '# 保存后的正文',
      dirty: false,
      savedVersion: 1,
    });
  });

  it('编辑、保存、关闭后重新打开仍从 ManagedFileSource 读取正式文本', async () => {
    const openManagedFileSource = vi.spyOn(importRepository, 'openManagedFileSource');
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    useMarkdownSessionStore.getState().updateText(materialId, '# 重新打开的新内容');

    await registry.execute(COMMAND_IDS.markdownSave, activeViewId());
    await registry.execute(COMMAND_IDS.readerCloseView, activeViewId());
    openManagedFileSource.mockClear();

    const savedMaterial = useLibraryStore.getState().materials.find((item) => item.id === materialId)!;
    await registry.execute(COMMAND_IDS.libraryOpenBook, savedMaterial);

    expect(useMarkdownSessionStore.getState().getSession(materialId)?.text).toBe(
      '# 重新打开的新内容',
    );
    expect(openManagedFileSource).toHaveBeenCalledWith(materialId);
  });

  it('放弃修改把缓冲区回退到已保存文本', async () => {
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    useMarkdownSessionStore.getState().updateText(materialId, '# 修改');

    await registry.execute(COMMAND_IDS.markdownDiscard, activeViewId());

    const session = useMarkdownSessionStore.getState().getSession(materialId);
    expect(session?.text).toBe(MARKDOWN_SOURCE);
    expect(session?.dirty).toBe(false);
  });

  it('关闭脏文档时选择保存:保存并关闭视图', async () => {
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    await registry.execute(COMMAND_IDS.markdownToggleSourceMode, activeViewId());
    useMarkdownSessionStore.getState().updateText(materialId, '# 保存内容');
    useShellUiStore.getState().openMarkdownDirtyClose(activeViewId(), 'close');

    await registry.execute(COMMAND_IDS.markdownCloseDirty, activeViewId(), 'save');

    const session = useMarkdownSessionStore.getState().getSession(materialId);
    expect(session?.dirty).toBe(false);
    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(0);
    expect(useShellUiStore.getState().markdownDirtyCloseViewId).toBeNull();
  });

  it('关闭保存等待期间出现新输入时保留脏视图与恢复快照', async () => {
    const saveMarkdown = importRepository.saveMarkdown.bind(importRepository);
    let releaseSave: (() => void) | undefined;
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.spyOn(importRepository, 'saveMarkdown').mockImplementationOnce(async (...args) => {
      await saveBlocked;
      return saveMarkdown(...args);
    });
    const viewId = activeViewId();
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    useMarkdownSessionStore.getState().updateText(materialId, '# 本次关闭保存内容');
    useShellUiStore.getState().openMarkdownDirtyClose(viewId, 'close');

    const closing = registry.execute(COMMAND_IDS.markdownCloseDirty, viewId, 'save');
    await vi.waitFor(() => expect(importRepository.saveMarkdown).toHaveBeenCalledOnce());
    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, viewId, '# 保存期间的新内容');
    releaseSave?.();
    await closing;

    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    expect(useMarkdownSessionStore.getState().getSession(materialId)).toMatchObject({
      text: '# 保存期间的新内容',
      dirty: true,
      savedVersion: 1,
    });
    expect(await importRepository.listMarkdownRecoveries()).toEqual([
      expect.objectContaining({
        materialId,
        content: '# 保存期间的新内容',
        baseDocumentVersion: 1,
        status: 'available',
      }),
    ]);
  });

  it('关闭脏文档时选择放弃:丢弃修改并关闭视图', async () => {
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    useMarkdownSessionStore.getState().updateText(materialId, '# 修改');
    useShellUiStore.getState().openMarkdownDirtyClose(activeViewId(), 'close');

    await registry.execute(COMMAND_IDS.markdownCloseDirty, activeViewId(), 'discard');

    const session = useMarkdownSessionStore.getState().getSession(materialId);
    expect(session?.text).toBe(MARKDOWN_SOURCE);
    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(0);
  });

  it('关闭脏文档时选择取消:不保存不放弃也不关闭', async () => {
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    useMarkdownSessionStore.getState().updateText(materialId, '# 修改');
    useShellUiStore.getState().openMarkdownDirtyClose(activeViewId(), 'close');

    await registry.execute(COMMAND_IDS.markdownCloseDirty, activeViewId(), 'cancel');

    const session = useMarkdownSessionStore.getState().getSession(materialId);
    expect(session?.text).toBe('# 修改');
    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    expect(useShellUiStore.getState().markdownDirtyCloseViewId).toBeNull();
  });

  it('脏文档直接关闭时被拦截并弹出确认对话框', async () => {
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    useMarkdownSessionStore.getState().updateText(materialId, '# 修改');

    await registry.execute(COMMAND_IDS.readerCloseView, activeViewId());

    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(1);
    expect(useShellUiStore.getState().markdownDirtyCloseViewId).toBe(activeViewId());
    expect(useShellUiStore.getState().markdownDirtyCloseAction).toBe('close');
  });

  it('非脏 Markdown 视图可直接关闭,不弹出确认', async () => {
    await registry.execute(COMMAND_IDS.readerCloseView, activeViewId());

    expect(useWorkspaceStore.getState().editorGroups[0]!.views).toHaveLength(0);
    expect(useShellUiStore.getState().markdownDirtyCloseViewId).toBeNull();
  });

  it('编辑缓冲区后以节制频率写入恢复快照', async () => {
    vi.useFakeTimers();
    const writeRecovery = vi.spyOn(importRepository, 'writeMarkdownRecovery');
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);

    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 第一次');
    await vi.advanceTimersByTimeAsync(500);
    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 最终内容');

    expect(writeRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(writeRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeRecovery).toHaveBeenCalledTimes(1);
    expect(writeRecovery).toHaveBeenCalledWith(materialId, '# 最终内容', 0);
  });

  it('同一材料的恢复快照写入按顺序完成,慢旧写不会覆盖快新写', async () => {
    vi.useFakeTimers();
    const writeRecovery = importRepository.writeMarkdownRecovery.bind(importRepository);
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const spy = vi
      .spyOn(importRepository, 'writeMarkdownRecovery')
      .mockImplementationOnce(async (...args) => {
        await firstBlocked;
        await writeRecovery(...args);
      })
      .mockImplementation(writeRecovery);
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);

    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 旧内容');
    await vi.advanceTimersByTimeAsync(1_000);
    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 最新内容');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spy).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await registry.execute(COMMAND_IDS.markdownFlushRecoveries);
    expect((await importRepository.listMarkdownRecoveries())[0]?.content).toBe('# 最新内容');
  });

  it('周期快照落盘后即使进程无关闭回调也能在重启时恢复', async () => {
    vi.useFakeTimers();
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 崩溃前内容');
    await vi.advanceTimersByTimeAsync(1_000);
    // 模拟移动端被系统直接终止:没有 flush 回调,仅运行时会话消失。
    useMarkdownSessionStore.getState().resetToDefault();

    await registry.execute(COMMAND_IDS.markdownCheckRecoveries);

    expect(useShellUiStore.getState().markdownRecoverySnapshots[0]).toMatchObject({
      materialId,
      status: 'available',
    });
    await registry.execute(COMMAND_IDS.markdownResolveRecovery, materialId, 'restore');
    expect(useMarkdownSessionStore.getState().getSession(materialId)).toMatchObject({
      text: '# 崩溃前内容',
      dirty: true,
      savedVersion: 0,
    });
    expect(await importRepository.listMarkdownRecoveries()).toHaveLength(1);
  });

  it('用户明确丢弃后清理恢复快照且不改变正式材料', async () => {
    await importRepository.writeMarkdownRecovery(materialId, '# 不再需要', 0);
    await registry.execute(COMMAND_IDS.markdownCheckRecoveries);

    await registry.execute(COMMAND_IDS.markdownResolveRecovery, materialId, 'discard');

    expect(await importRepository.listMarkdownRecoveries()).toEqual([]);
    expect(await readManagedText(importRepository, materialId)).toBe(MARKDOWN_SOURCE);
  });

  it('损坏快照收到恢复意图时不会被误当作丢弃', async () => {
    const discardRecovery = vi.spyOn(importRepository, 'discardMarkdownRecovery');
    useShellUiStore.getState().setMarkdownRecoverySnapshots([
      {
        materialId,
        content: null,
        baseDocumentVersion: null,
        updatedAt: null,
        status: 'corrupt',
      },
    ]);

    await registry.execute(COMMAND_IDS.markdownResolveRecovery, materialId, 'restore');

    expect(discardRecovery).not.toHaveBeenCalled();
    expect(useShellUiStore.getState().markdownRecoverySnapshots).toHaveLength(1);
  });

  it('基础版本变化时展示冲突且不会自动覆盖正式内容', async () => {
    await importRepository.writeMarkdownRecovery(materialId, '# 未保存 v0', 0);
    await importRepository.saveMarkdown(materialId, '# 正式 v1');

    await registry.execute(COMMAND_IDS.markdownCheckRecoveries);

    expect(useShellUiStore.getState().markdownRecoverySnapshots[0]?.status).toBe('conflict');
    expect(useMarkdownSessionStore.getState().getSession(materialId)?.text).not.toBe('# 未保存 v0');
    expect(await readManagedText(importRepository, materialId)).toBe('# 正式 v1');
  });

  it('恢复快照会使活动阅读 Runtime 失效并从恢复后的共享缓冲区重建', async () => {
    const before = useReaderRuntime.getState().getDocument(activeViewId())!;
    const close = vi.spyOn(before, 'close');
    await importRepository.writeMarkdownRecovery(materialId, '# 恢复后的正文', 0);
    await registry.execute(COMMAND_IDS.markdownCheckRecoveries);

    await registry.execute(COMMAND_IDS.markdownResolveRecovery, materialId, 'restore');

    const after = useReaderRuntime.getState().getDocument(activeViewId());
    expect(close).toHaveBeenCalledOnce();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(useMarkdownSessionStore.getState().getSession(materialId)).toMatchObject({
      text: '# 恢复后的正文',
      dirty: true,
      savedVersion: 0,
    });
  });

  it('正式保存成功后清理恢复快照', async () => {
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    useMarkdownSessionStore.getState().updateText(materialId, '# 新内容');
    await importRepository.writeMarkdownRecovery(materialId, '# 新内容', 0);

    await registry.execute(COMMAND_IDS.markdownSave, activeViewId());

    expect(await importRepository.listMarkdownRecoveries()).toEqual([]);
  });

  it('正式保存等待期间的新输入保持为脏缓冲区并补写新版本快照', async () => {
    const saveMarkdown = importRepository.saveMarkdown.bind(importRepository);
    let releaseSave: (() => void) | undefined;
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.spyOn(importRepository, 'saveMarkdown').mockImplementationOnce(async (...args) => {
      await saveBlocked;
      return saveMarkdown(...args);
    });
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 本次保存内容');

    const saving = registry.execute(COMMAND_IDS.markdownSave, activeViewId());
    await vi.waitFor(() => expect(importRepository.saveMarkdown).toHaveBeenCalledOnce());
    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 保存期间的新内容');
    releaseSave?.();
    await saving;

    expect(await readManagedText(importRepository, materialId)).toBe('# 本次保存内容');
    expect(useMarkdownSessionStore.getState().getSession(materialId)).toMatchObject({
      text: '# 保存期间的新内容',
      dirty: true,
      savedVersion: 1,
    });
    expect(await importRepository.listMarkdownRecoveries()).toEqual([
      expect.objectContaining({
        materialId,
        content: '# 保存期间的新内容',
        baseDocumentVersion: 1,
        status: 'available',
      }),
    ]);
  });

  it('正式保存失败时立即保留最新缓冲区恢复快照', async () => {
    vi.useFakeTimers();
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 保存失败前内容');
    vi.spyOn(importRepository, 'saveMarkdown').mockRejectedValueOnce(new Error('磁盘空间不足'));

    await expect(
      registry.execute(COMMAND_IDS.markdownSave, activeViewId()),
    ).rejects.toThrow('磁盘空间不足');

    expect(await importRepository.listMarkdownRecoveries()).toEqual([
      expect.objectContaining({
        materialId,
        content: '# 保存失败前内容',
        baseDocumentVersion: 0,
        status: 'available',
      }),
    ]);
  });

  it('恢复快照写入失败时正式材料继续可用并显示安全退化反馈', async () => {
    vi.useFakeTimers();
    vi.spyOn(importRepository, 'writeMarkdownRecovery').mockRejectedValueOnce(
      new Error('磁盘空间不足'),
    );
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);

    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 未保存内容');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(useShellUiStore.getState().statusMessage).toContain('恢复快照写入失败');
    expect(await readManagedText(importRepository, materialId)).toBe(MARKDOWN_SOURCE);
  });

  it('移动端强制终止前可立即 flush 最新脏缓冲区', async () => {
    vi.useFakeTimers();
    useMarkdownSessionStore.getState().openSession(materialId, MARKDOWN_SOURCE, 0);
    await registry.execute(COMMAND_IDS.markdownUpdateBuffer, activeViewId(), '# 强制终止前内容');

    await registry.execute(COMMAND_IDS.markdownFlushRecoveries);

    expect(await importRepository.listMarkdownRecoveries()).toEqual([
      expect.objectContaining({
        materialId,
        content: '# 强制终止前内容',
        baseDocumentVersion: 0,
        status: 'available',
      }),
    ]);
  });
});
