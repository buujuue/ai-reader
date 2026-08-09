import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_IDS, CommandRegistry } from '../commands/commandRegistry';
import {
  addInMemorySource,
  createInMemoryImportRepository,
} from '../domain/library/inMemoryImportRepository';
import type { FoliateViewHost } from '../domain/reader/viewHost';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { registerReaderCommands } from './readerCommands';
import { useLibraryStore } from './libraryStore';
import { useMarkdownSessionStore } from './markdownSessionStore';
import { registerMarkdownCommands } from './markdownCommands';
import { useReaderRuntime } from './readerRuntime';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';

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
    useWorkspaceStore.getState().resetToDefault();
    useReaderRuntime.setState({ documents: new Map() });
    useMarkdownSessionStore.getState().resetToDefault();
    useShellUiStore.setState({
      markdownDirtyCloseViewId: null,
      markdownDirtyCloseAction: null,
    });
    const material = await setupWithMarkdown();
    useLibraryStore.setState({ materials: [material], trashedMaterials: [] });
    registerReaderCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    // 注册 reader 命令后,再注册 markdown 命令(依赖 readerCloseView)。
    registerMarkdownCommands(registry, {
      importRepository,
      workspaceRepository,
      viewHostFactory: () => createFakeViewHost(),
    });
    await registry.execute(COMMAND_IDS.libraryOpenBook, material);
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
    const bytes = await importRepository.readManagedFile(materialId);
    expect(new TextDecoder().decode(bytes)).toBe('# 新内容');
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
});