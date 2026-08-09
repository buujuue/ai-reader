import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, Code2, Settings2, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { formatFromSourceFileName } from '../domain/library/materialFormat';
import type { EditorGroupState } from '../domain/workspace/workspaceState';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { ReadingView } from './ReadingView';

export function EditorArea() {
  const splitDirection = useWorkspaceStore((state) => state.splitDirection);
  const editorGroups = useWorkspaceStore((state) => state.editorGroups);
  const hasSplit = editorGroups.length >= 2;

  if (editorGroups.length === 0 || (editorGroups.length === 1 && editorGroups[0]!.views.length === 0)) {
    return <EmptyEditorArea />;
  }

  return (
    <section
      aria-label="编辑器区"
      className={`flex min-h-0 min-w-0 flex-1 bg-zinc-950 ${
        splitDirection === 'down' ? 'flex-col' : 'flex-row'
      }`}
    >
      {editorGroups.map((group, index) => (
        <EditorGroupPane key={group.id} group={group} index={index} hasSplit={hasSplit} />
      ))}
    </section>
  );
}

function EmptyEditorArea() {
  return (
    <section
      aria-label="编辑器区"
      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-zinc-950 px-6"
    >
      <BookOpen size={36} aria-hidden className="text-zinc-600" />
      <h1 className="text-lg font-semibold text-zinc-200">AI Reader</h1>
      <p className="max-w-md text-center text-sm leading-6 text-zinc-500">
        从左侧书库选择一本阅读材料打开,在此处以标签形式阅读。
      </p>
    </section>
  );
}

function EditorGroupPane({
  group,
  index,
  hasSplit,
}: {
  group: EditorGroupState;
  index: number;
  hasSplit: boolean;
}) {
  const { commands } = useAppServices();
  const materials = useLibraryStore((state) => state.materials);
  const activeEditorGroupId = useWorkspaceStore((state) => state.activeEditorGroupId);
  const isActiveGroup = activeEditorGroupId === group.id;
  const activeView = group.views.find((view) => view.id === group.activeViewId);
  const activeMaterial = activeView
    ? materials.find((material) => material.id === activeView.materialId) ?? null
    : null;
  const activeIsMarkdown =
    activeMaterial && formatFromSourceFileName(activeMaterial.sourceFileName) === 'markdown';
  const activeInSourceMode = activeView?.sourceMode ?? false;

  const focusGroup = () => {
    if (isActiveGroup) return;
    void commands
      .execute(COMMAND_IDS.workbenchFocusEditorGroup, group.id)
      .catch(() => undefined);
  };
  const handleCloseView = (viewId: string) => {
    void commands.execute(COMMAND_IDS.readerCloseView, viewId).catch(() => undefined);
  };
  const handleActivateView = (viewId: string) => {
    if (isActiveGroup && group.activeViewId === viewId) return;
    void commands.execute(COMMAND_IDS.readerActivateView, viewId).catch(() => undefined);
  };
  const handleBack = () => {
    if (!group.activeViewId) return;
    void commands.execute(COMMAND_IDS.readerBack, group.activeViewId).catch(() => undefined);
  };
  const handleForward = () => {
    if (!group.activeViewId) return;
    void commands.execute(COMMAND_IDS.readerForward, group.activeViewId).catch(() => undefined);
  };
  const handleOpenTypography = () => {
    if (!group.activeViewId) return;
    useShellUiStore.getState().openTypographyEditor(group.activeViewId);
  };
  const handleToggleSourceMode = () => {
    if (!group.activeViewId) return;
    void commands
      .execute(COMMAND_IDS.markdownToggleSourceMode, group.activeViewId)
      .catch(() => undefined);
  };
  const handleSplitRight = () => {
    void commands.execute(COMMAND_IDS.workbenchSplitEditorGroupRight).catch(() => undefined);
  };
  const handleSplitDown = () => {
    void commands.execute(COMMAND_IDS.workbenchSplitEditorGroupDown).catch(() => undefined);
  };

  return (
    <section
      aria-label={`编辑器组 ${index + 1}`}
      onPointerDown={focusGroup}
      className={`flex min-h-0 min-w-0 flex-1 basis-0 flex-col bg-zinc-950 ${
        isActiveGroup ? 'ring-1 ring-inset ring-sky-900/70' : ''
      }`}
    >
      <div
        role="tablist"
        aria-label={`阅读标签 - 编辑器组 ${index + 1}`}
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900/40 px-2"
      >
        <div className="mr-1 flex shrink-0 items-center gap-0.5 border-r border-zinc-800 pr-2">
          <button
            type="button"
            aria-label="后退"
            title="后退到上一个位置"
            onClick={handleBack}
            disabled={!group.activeViewId}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-40"
          >
            <ArrowLeft size={15} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="前进"
            title="前进到下一个位置"
            onClick={handleForward}
            disabled={!group.activeViewId}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-40"
          >
            <ArrowRight size={15} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="阅读排版"
            title="调整阅读排版(字体、字号、行距、页边距、主题、分页/滚动)"
            onClick={handleOpenTypography}
            disabled={!group.activeViewId}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-40"
          >
            <Settings2 size={15} aria-hidden />
          </button>
          {activeIsMarkdown ? (
            <button
              type="button"
              aria-label={activeInSourceMode ? '退出源码模式' : '进入源码模式'}
              title={activeInSourceMode ? '退出源码模式' : '进入源码模式(Ctrl+切换)'}
              onClick={handleToggleSourceMode}
              className={`flex h-7 w-7 items-center justify-center rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 ${
                activeInSourceMode
                  ? 'bg-sky-600/20 text-sky-300'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
              }`}
            >
              <Code2 size={15} aria-hidden />
            </button>
          ) : null}
        </div>
        {group.views.map((view) => {
          const material = materials.find((candidate) => candidate.id === view.materialId);
          const isActive = view.id === group.activeViewId;
          return (
            <div
              key={view.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => handleActivateView(view.id)}
              className={`group flex max-w-56 shrink-0 cursor-pointer items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'border-sky-500 bg-zinc-900 text-zinc-100'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <span className="truncate">{material?.title ?? '阅读中'}</span>
              <button
                type="button"
                aria-label={`关闭标签 ${material?.title ?? ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  handleCloseView(view.id);
                }}
                className="rounded p-0.5 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:opacity-100 focus-visible:outline"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 border-l border-zinc-800 pl-2">
          <button
            type="button"
            aria-label="向右拆分编辑器组"
            title="向右拆分编辑器组"
            onClick={handleSplitRight}
            disabled={hasSplit}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ArrowRight size={15} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="向下拆分编辑器组"
            title="向下拆分编辑器组"
            onClick={handleSplitDown}
            disabled={hasSplit}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ArrowDown size={15} aria-hidden />
          </button>
        </div>
      </div>
      {activeView ? (
        <div className="min-h-0 min-w-0 flex-1">
          <ReadingView key={activeView.id} viewId={activeView.id} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-zinc-600">
          从左侧书库打开阅读材料
        </div>
      )}
    </section>
  );
}
