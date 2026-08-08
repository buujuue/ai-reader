import { ArrowLeft, ArrowRight, BookOpen, Settings2, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { ReadingView } from './ReadingView';

export function EditorArea() {
  const { commands } = useAppServices();
  const editorGroups = useWorkspaceStore((state) => state.editorGroups);
  const activeEditorGroupId = useWorkspaceStore((state) => state.activeEditorGroupId);
  const materials = useLibraryStore((state) => state.materials);

  const group = editorGroups.find((group) => group.id === activeEditorGroupId);
  const activeView = group?.views.find((view) => view.id === group.activeViewId);

  const handleCloseView = (viewId: string) => {
    void commands.execute(COMMAND_IDS.readerCloseView, viewId).catch(() => undefined);
  };

  const handleActivateView = (viewId: string) => {
    if (group?.activeViewId === viewId) return;
    useWorkspaceStore.getState().setActiveView(activeEditorGroupId, viewId);
  };

  const handleBack = () => {
    void commands.execute(COMMAND_IDS.readerBack).catch(() => undefined);
  };

  const handleForward = () => {
    void commands.execute(COMMAND_IDS.readerForward).catch(() => undefined);
  };

  const handleOpenTypography = () => {
    if (!group?.activeViewId) return;
    useWorkspaceStore.getState().setActiveView(activeEditorGroupId, group.activeViewId);
    useShellUiStore.getState().openTypographyEditor(group.activeViewId);
  };

  if (!group || group.views.length === 0) {
    return (
      <section
        aria-label="编辑器区"
        className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-zinc-950 px-6"
      >
        <BookOpen size={36} aria-hidden className="text-zinc-600" />
        <h1 className="text-lg font-semibold text-zinc-200">AI Reader</h1>
        <p className="max-w-md text-center text-sm leading-6 text-zinc-500">
          从左侧书库选择一本 EPUB 打开,在此处以标签形式阅读。
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="编辑器区"
      className="flex min-w-0 flex-1 flex-col bg-zinc-950"
    >
      <div
        role="tablist"
        aria-label="阅读标签"
        className="flex shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900/40 px-2"
      >
        <div className="mr-1 flex shrink-0 items-center gap-0.5 border-r border-zinc-800 pr-2">
          <button
            type="button"
            aria-label="后退"
            title="后退到上一个位置"
            onClick={handleBack}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          >
            <ArrowLeft size={15} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="前进"
            title="前进到下一个位置"
            onClick={handleForward}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          >
            <ArrowRight size={15} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="阅读排版"
            title="调整阅读排版(字体、字号、行距、页边距、主题、分页/滚动)"
            onClick={handleOpenTypography}
            className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          >
            <Settings2 size={15} aria-hidden />
          </button>
        </div>
        {group.views.map((view) => {
          const material = materials.find((material) => material.id === view.materialId);
          const isActive = view.id === group.activeViewId;
          return (
            <div
              key={view.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => handleActivateView(view.id)}
              className={`group flex max-w-56 cursor-pointer items-center gap-2 rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'border-sky-500 bg-zinc-900 text-zinc-100'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <span className="truncate">{material?.title ?? '阅读中'}</span>
              <button
                type="button"
                aria-label={`关闭标签 ${material?.title ?? ''}`}
                onClick={() => handleCloseView(view.id)}
                className="rounded p-0.5 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:opacity-100 focus-visible:outline"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      {activeView ? (
        <div className="min-h-0 flex-1">
          <ReadingView key={activeView.id} viewId={activeView.id} />
        </div>
      ) : null}
    </section>
  );
}