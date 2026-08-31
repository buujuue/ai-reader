import {
  ArrowDown,
  ArrowRight,
  Code2,
  MoreHorizontal,
  Pencil,
  Settings2,
  Star,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS, type CommandId } from '../commands/commandRegistry';
import { formatFromSourceFileName } from '../domain/library/materialFormat';
import type { BookDocument } from '../domain/reader/bookDocument';
import { ReadingInputController } from '../domain/reader/readingInput';
import { useReaderRuntime } from '../workbench/readerRuntime';
import {
  mountViewDocument,
  registerReaderRuntimeInputCleanup,
} from '../workbench/readerCommands';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { MarkdownSourceEditor } from './MarkdownSourceEditor';
import { SearchBar } from './SearchBar';
import { SelectionToolbar } from './SelectionToolbar';

/**
 * 单个阅读视图(标签)的正文区域。它把活动视图的 BookDocument 挂载到自身容器，
 * 把键盘与内容文档的输入(滚轮/点击/触摸)统一桥接到 Command Registry 的翻页命令，
 * 并向 Reader Runtime 注册输入接线清理。Runtime 的 flush、挂起和关闭由命令层统一负责。
 */
export function ReadingView({ viewId, visible = true }: { viewId: string; visible?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountedDocumentRef = useRef<BookDocument | null>(null);
  const previousVisibilityRef = useRef<boolean | null>(null);
  const { commands, importRepository, workspaceRepository, annotationRepository } = useAppServices();
  const document = useReaderRuntime((state) => state.documents.get(viewId));
  const runtimeLifecycle = useReaderRuntime((state) =>
    state.documentLifecycles.get(viewId),
  );
  const documentState = useReaderRuntime((state) => state.documentStates.get(viewId));
  const groupId = useWorkspaceStore((state) =>
    state.editorGroups.find((group) => group.views.some((view) => view.id === viewId))?.id ?? null,
  );
  const isActiveView = useWorkspaceStore((state) => {
    const group = state.editorGroups.find((candidate) => candidate.id === groupId);
    return state.activeEditorGroupId === groupId && group?.activeViewId === viewId;
  });
  const sourceMode = useWorkspaceStore((state) => {
    for (const group of state.editorGroups) {
      const view = group.views.find((v) => v.id === viewId);
      if (view) return view.sourceMode;
    }
    return false;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || sourceMode || !visible || runtimeLifecycle === 'suspended') return;
    const existing = useReaderRuntime.getState().getDocument(viewId);
    if (!existing) return;
    if (mountedDocumentRef.current === existing) return;
    mountedDocumentRef.current = existing;

    const workspace = useWorkspaceStore.getState();
    const group = workspace.editorGroups.find((g) =>
      g.views.some((view) => view.id === viewId),
    );
    const view = group?.views.find((view) => view.id === viewId);
    mountViewDocument(
      existing,
      viewId,
      container,
      view?.location ?? null,
      { importRepository, workspaceRepository, annotationRepository },
    );
    return () => {
      if (mountedDocumentRef.current === existing) {
        mountedDocumentRef.current = null;
      }
    };
  }, [
    importRepository,
    runtimeLifecycle,
    sourceMode,
    visible,
    workspaceRepository,
    viewId,
    document,
  ]);

  // 紧凑布局只保留活动 Editor Group 可见。隐藏组仍留在 React 树中以保留
  // Workspace State，但其 Reader Runtime 必须摘下 renderer、清理输入和后台任务；
  // 重新显示时再由同一 View 的缓存命中路径挂回原对象。
  useEffect(() => {
    const previousVisibility = previousVisibilityRef.current;
    previousVisibilityRef.current = visible;
    if (
      sourceMode ||
      previousVisibility === visible ||
      (previousVisibility === null && visible)
    ) return;

    if (!visible) {
      mountedDocumentRef.current = null;
      void commands.execute(COMMAND_IDS.readerSuspendViewRuntime, viewId).catch((error: unknown) => {
        console.error('隐藏 Editor Group 的阅读 Runtime 挂起失败', { viewId, error });
      });
      return;
    }

    // 恢复必须回到已注册的 Command，确保 PDF.js、Foliate 工厂和其它平台依赖
    // 使用 AppServices 组装时注入的同一份实例，而不是由组件拼一份不完整依赖。
    void commands.execute(COMMAND_IDS.readerActivateView, viewId).catch((error: unknown) => {
      console.error('显示 Editor Group 的阅读 Runtime 恢复失败', { viewId, error });
    });
  }, [
    annotationRepository,
    commands,
    importRepository,
    sourceMode,
    visible,
    viewId,
    workspaceRepository,
  ]);

  // 统一阅读输入:键盘 + 内容文档(iframe 内)的滚轮/点击/触摸都收敛到同一组翻页命令。
  useEffect(() => {
    const book = useReaderRuntime.getState().getDocument(viewId);
    if (!book || sourceMode || !visible || runtimeLifecycle === 'suspended') return;
    const materialId = useWorkspaceStore.getState().editorGroups
      .flatMap((group) => group.views)
      .find((view) => view.id === viewId)?.materialId;
    if (!materialId) return;

    const controller = new ReadingInputController(
      {
        nextCommandId: COMMAND_IDS.readerNextPage,
        prevCommandId: COMMAND_IDS.readerPrevPage,
        execute: (commandId, targetViewId) => {
          const focus =
            groupId && useWorkspaceStore.getState().activeEditorGroupId !== groupId
              ? commands.execute(COMMAND_IDS.workbenchFocusEditorGroup, groupId)
              : Promise.resolve();
          return focus
            .then(() => commands.execute(commandId as CommandId, targetViewId))
            .catch(() => undefined);
        },
        getFlow: () =>
          useWorkspaceStore.getState().getEffectiveTypography(materialId).flow,
      },
      viewId,
    );

    // 把输入监听器附加到每个内容文档(含后续随章节加载出现的新文档)。
    // PDF 的内容文档就是应用主文档,但事件必须收窄到当前 ReadingView 的正文容器;
    // 工具栏、搜索栏、对话框和其它 Editor Group 不属于翻页作用域。
    const detachList: Array<() => void> = [];
    const attachedDocs = new Set<Document>();
    const isTopLevelDocument = (doc: Document) => doc.defaultView === window;
    const attachDoc = (doc: Document) => {
      if (attachedDocs.has(doc)) return;
      if (isTopLevelDocument(doc)) {
        if (book.format === 'pdf' && containerRef.current) {
          detachList.push(controller.attach(doc, containerRef.current));
          attachedDocs.add(doc);
        }
        return;
      }
      attachedDocs.add(doc);
      detachList.push(controller.attach(doc));
      const handleContentSearchShortcut = (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return;
        event.preventDefault();
        const focus =
          groupId && useWorkspaceStore.getState().activeEditorGroupId !== groupId
            ? commands.execute(COMMAND_IDS.workbenchFocusEditorGroup, groupId)
            : Promise.resolve();
        void focus
          .then(() => commands.execute(COMMAND_IDS.readerSearchOpen, viewId))
          .catch(() => undefined);
      };
      doc.addEventListener('keydown', handleContentSearchShortcut);
      detachList.push(() => doc.removeEventListener('keydown', handleContentSearchShortcut));
    };
    for (const doc of book.getContentDocs()) {
      attachDoc(doc);
    }
    const offContentCreate = book.onContentCreate(attachDoc);

    // 应用窗口级键盘:焦点在应用内但不在内容帧时,方向键/PageUp/PageDown 翻页。
    // 焦点在输入控件时不抢占。
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      controller.handleKey({
        key: event.key,
        flow: useWorkspaceStore.getState().getEffectiveTypography(materialId).flow,
        hasModifier: event.ctrlKey || event.metaKey || event.altKey,
      });
    };
    if (isActiveView) {
      window.addEventListener('keydown', handleWindowKeyDown);
    }

    const cleanup = () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
      offContentCreate();
      for (const detach of detachList) {
        detach();
      }
    };
    return registerReaderRuntimeInputCleanup(viewId, cleanup);
  }, [
    commands,
    document,
    groupId,
    isActiveView,
    runtimeLifecycle,
    sourceMode,
    viewId,
    visible,
  ]);

  const materialId = useWorkspaceStore((state) => {
    for (const group of state.editorGroups) {
      const view = group.views.find((candidate) => candidate.id === viewId);
      if (view) return view.materialId;
    }
    return null;
  });
  const materialFormat = useLibraryStore((state) => {
    const material = materialId ? state.materials.find((item) => item.id === materialId) : null;
    return material ? formatFromSourceFileName(material.sourceFileName) : null;
  });
  // Runtime 失效后 document 可能暂时为空,源码模式仍必须继续由 CodeMirror
  // 占据正文区域,不能因为等待重建而退回显示旧的阅读容器。
  const isMarkdownSourceMode =
    sourceMode && (document?.format === 'markdown' || materialFormat === 'markdown');
  const hasSplit = useWorkspaceStore((state) => state.editorGroups.length >= 2);

  return (
    <div
      className="app-reading-view relative h-full w-full overflow-hidden bg-zinc-950"
      onPointerDown={() => {
        if (groupId && useWorkspaceStore.getState().activeEditorGroupId !== groupId) {
          void commands
            .execute(COMMAND_IDS.workbenchFocusEditorGroup, groupId)
            .catch(() => undefined);
        }
      }}
    >
      {materialId ? (
        <MaterialReadingToolbar
          materialId={materialId}
          viewId={viewId}
          groupId={groupId}
          isMarkdown={document?.format === 'markdown' || materialFormat === 'markdown'}
          isSourceMode={isMarkdownSourceMode}
          hasSplit={hasSplit}
        />
      ) : null}
      {isMarkdownSourceMode ? (
        <div className="min-h-0 min-w-0 flex-1">
          <MarkdownSourceEditor viewId={viewId} />
        </div>
      ) : (
        <div className="relative min-h-0 min-w-0 flex-1">
          <SearchBar viewId={viewId} />
          <SelectionToolbar viewId={viewId} />
          <div
            ref={containerRef}
            data-view-id={viewId}
            className="h-full w-full overflow-hidden bg-zinc-950"
          />
          {documentState?.status === 'error' ? (
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center p-6"
              role="alert"
            >
              <div className="pointer-events-auto max-w-lg rounded-lg border border-[var(--prototype-danger)]/45 bg-[var(--prototype-surface-strong)] px-5 py-4 text-sm text-[var(--prototype-text)] shadow-lg">
                <p className="font-medium">无法打开阅读材料</p>
                <p className="mt-2 break-words text-xs leading-5 text-[var(--prototype-text-secondary)]">
                  {documentState.message}
                </p>
                <p className="mt-2 text-xs leading-5 text-[var(--prototype-text-muted)]">
                  请重新打开材料；如果仍然失败，请把这条错误信息反馈给开发者。
                </p>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MaterialReadingToolbar({
  materialId,
  viewId,
  groupId,
  isMarkdown,
  isSourceMode,
  hasSplit,
}: {
  materialId: string;
  viewId: string;
  groupId: string | null;
  isMarkdown: boolean;
  isSourceMode: boolean;
  hasSplit: boolean;
}) {
  const { commands } = useAppServices();
  const material = useLibraryStore((state) =>
    state.materials.find((candidate) => candidate.id === materialId),
  );
  const primaryMaterialId = useWorkspaceStore((state) => state.primaryMaterialId);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const executeForGroup = (commandId: CommandId, ...args: unknown[]) => {
    const focus =
      groupId && useWorkspaceStore.getState().activeEditorGroupId !== groupId
        ? commands.execute(COMMAND_IDS.workbenchFocusEditorGroup, groupId)
        : Promise.resolve();
    void focus
      .then(() => commands.execute(commandId, ...args))
      .catch(() => undefined);
  };

  const openTypography = () => {
    useShellUiStore.getState().openTypographyEditor(viewId);
  };

  const toggleSourceMode = () => {
    executeForGroup(COMMAND_IDS.markdownToggleSourceMode, viewId);
  };

  const splitEditor = (commandId: CommandId) => {
    setOpen(false);
    executeForGroup(commandId);
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const exportAnnotations = () => {
    if (exporting) return;
    setExporting(true);
    void commands
      .execute(COMMAND_IDS.annotationExportMarkdown, materialId)
      .catch(() => undefined)
      .finally(() => {
        setExporting(false);
        setOpen(false);
      });
  };

  const setPrimary = () => {
    void commands
      .execute(
        COMMAND_IDS.workbenchSetPrimaryMaterial,
        primaryMaterialId === materialId ? null : materialId,
      )
      .catch(() => undefined)
      .finally(() => setOpen(false));
  };

  const editMetadata = () => {
    setOpen(false);
    useShellUiStore.getState().openMetadataEditor(materialId);
  };

  const trashMaterial = () => {
    setOpen(false);
    void commands.execute(COMMAND_IDS.libraryTrash, materialId).catch(() => undefined);
  };

  return (
    <div
      role="toolbar"
      aria-label={`当前阅读工具 - ${material?.title ?? '阅读材料'}`}
      className="app-reading-toolbar"
    >
      <div className="app-reading-toolbar-actions" aria-label="阅读工具">
        <button
          type="button"
          aria-label="阅读排版"
          title="调整阅读排版（字体、字号、行距、页边距、主题、分页/滚动）"
          onClick={openTypography}
          className="app-icon-button"
        >
          <Settings2 size={16} aria-hidden />
        </button>
        {isMarkdown ? (
          <button
            type="button"
            aria-label={isSourceMode ? '退出源码模式' : '进入源码模式'}
            title={isSourceMode ? '退出源码模式' : '进入源码模式（Ctrl+切换）'}
            onClick={toggleSourceMode}
            className={`app-icon-button ${isSourceMode ? 'is-active' : ''}`}
          >
            <Code2 size={16} aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="app-reading-toolbar-title" title={material?.title ?? '阅读材料'}>
        <span>{material?.title ?? '阅读材料'}</span>
      </div>
      <div className="app-reading-toolbar-end">
        {hasSplit ? (
          <button
            type="button"
            aria-label="关闭当前拆分区"
            title="关闭当前拆分区"
            onClick={() => executeForGroup(COMMAND_IDS.readerCloseView, viewId)}
            className="app-icon-button"
          >
            <X size={16} aria-hidden />
          </button>
        ) : null}
        <div ref={menuRef} className="relative shrink-0">
          <button
            ref={menuButtonRef}
            type="button"
            aria-label="材料更多操作"
            aria-haspopup="menu"
            aria-expanded={open}
            title="材料更多操作"
            onClick={() => setOpen((visible) => !visible)}
            className="app-icon-button"
          >
            <MoreHorizontal size={17} aria-hidden />
          </button>
          {open ? (
            <div role="menu" aria-label="材料更多操作菜单" className="app-material-menu">
              <button
                type="button"
                role="menuitem"
                disabled={hasSplit}
                onClick={() => splitEditor(COMMAND_IDS.workbenchSplitEditorGroupRight)}
              >
                <ArrowRight size={14} aria-hidden />
                向右拆分编辑器组
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={hasSplit}
                onClick={() => splitEditor(COMMAND_IDS.workbenchSplitEditorGroupDown)}
              >
                <ArrowDown size={14} aria-hidden />
                向下拆分编辑器组
              </button>
              <div role="separator" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const returnFocusTarget = menuButtonRef.current;
                setOpen(false);
                void commands
                  .execute(COMMAND_IDS.workbenchOpenAnnotationPanel, materialId, returnFocusTarget)
                  .catch(() => undefined);
              }}
            >
              <StickyNote size={14} aria-hidden />
              查看本材料批注
            </button>
            <button type="button" role="menuitem" disabled={exporting} onClick={exportAnnotations}>
              <span aria-hidden className="w-3.5" />
              {exporting ? '正在导出…' : '导出本材料批注'}
            </button>
            <div role="separator" />
            <button type="button" role="menuitem" onClick={setPrimary}>
              {primaryMaterialId === materialId ? <X size={14} aria-hidden /> : <Star size={14} aria-hidden />}
              {primaryMaterialId === materialId ? '取消主要材料' : '设为主要材料'}
            </button>
            <div role="separator" />
            <button type="button" role="menuitem" onClick={editMetadata}>
              <Pencil size={14} aria-hidden />
              编辑元数据
            </button>
            <button
              type="button"
              role="menuitem"
              className="library-menu-danger"
              onClick={trashMaterial}
            >
              <Trash2 size={14} aria-hidden />
              移入回收站
            </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
