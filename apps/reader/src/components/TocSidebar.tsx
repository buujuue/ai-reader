import { ChevronRight, ListTree } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { TocItem } from '../domain/reader/toc';
import { useReaderRuntime } from '../workbench/readerRuntime';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { SidebarPanelHeader } from './SidebarPanelHeader';

function TocNode({
  item,
  depth,
  onNavigate,
}: {
  item: TocItem;
  depth: number;
  onNavigate: (href: string) => void;
}) {
  const hasChildren = item.subitems !== null && item.subitems.length > 0;
  return (
    <li>
      <button
        type="button"
        onClick={() => item.href && onNavigate(item.href)}
        title={item.label}
        aria-label={`跳转到章节 ${item.label}`}
        className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
        style={{ paddingInlineStart: `${depth * 12 + 8}px` }}
      >
        {hasChildren ? (
          <ChevronRight size={12} aria-hidden className="shrink-0 text-zinc-500" />
        ) : (
          <span aria-hidden className="w-3 shrink-0" />
        )}
        <span className="truncate">{item.label}</span>
      </button>
      {hasChildren ? (
        <ul>
          {item.subitems!.map((child, index) => (
            <TocNode key={`${child.href}-${index}`} item={child} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * 目录侧栏:展示活动阅读视图的 BookDocument 分层目录,点击条目经统一
 * Command 执行显式跳转(压入导航历史)。TOC 来自 ActivityBar 的目录按钮。
 */
export function TocSidebar() {
  const { commands } = useAppServices();
  const activeEditorGroupId = useWorkspaceStore((state) => state.activeEditorGroupId);
  const activeViewId = useWorkspaceStore(
    (state) =>
      state.editorGroups.find((group) => group.id === state.activeEditorGroupId)?.activeViewId ??
      null,
  );
  const document = useReaderRuntime((state) =>
    activeViewId ? state.documents.get(activeViewId) : undefined,
  );
  const documentState = useReaderRuntime((state) =>
    activeViewId ? state.documentStates.get(activeViewId) : undefined,
  );
  const toc = document?.getTOC() ?? [];
  const tocSource =
    document?.getTOCSource?.() ??
    (toc.some((item) => item.source === 'derived') ? 'derived' : 'native');

  const handleNavigate = (href: string) => {
    if (!activeViewId) return;
    void commands.execute(COMMAND_IDS.readerGoToHref, activeViewId, href).catch(() => undefined);
  };

  return (
    <aside
      aria-label="目录侧栏"
      className="app-sidebar-panel"
    >
      <SidebarPanelHeader icon={ListTree} title={tocSource === 'derived' ? '目录 · 正文推导' : '目录'} />
      <div className="flex-1 overflow-y-auto py-2">
        {documentState?.status === 'loading' ? (
          <p className="px-3 py-4 text-xs leading-5 text-zinc-500" role="status">
            正在加载目录…
          </p>
        ) : documentState?.status === 'error' ? (
          <p className="px-3 py-4 text-xs leading-5 text-[var(--prototype-danger)]" role="alert">
            目录加载失败：{documentState.message}
          </p>
        ) : toc.length === 0 ? (
          <p className="px-3 py-4 text-xs leading-5 text-zinc-500">
            {tocSource === 'derived'
              ? '正文中没有可靠的章节标题，当前书籍仍可通过翻页阅读。'
              : '当前书籍没有可用的目录。'}
          </p>
        ) : (
          <>
            {tocSource === 'derived' ? (
              <p className="px-3 pb-2 text-[11px] leading-4 text-zinc-500" role="note">
                目录根据正文标题生成，仅用于本地导航，不会改写原书。
              </p>
            ) : null}
            <ul>
              {toc.map((item, index) => (
                <TocNode key={`${item.href}-${index}`} item={item} depth={0} onNavigate={handleNavigate} />
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
