import { LibraryBig, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from '../workbench/libraryStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';

export function ActivityBar() {
  const { commands } = useAppServices();
  const primarySidebarVisible = useWorkspaceStore((state) => state.primarySidebarVisible);
  const importing = useLibraryStore((state) => state.importing);

  const handleTogglePrimarySidebar = () => {
    void commands.execute(COMMAND_IDS.workbenchTogglePrimarySidebar).catch(() => undefined);
  };

  const handleImport = () => {
    void commands.execute(COMMAND_IDS.libraryImportOne).catch(() => undefined);
  };

  return (
    <nav
      aria-label="活动栏"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-zinc-800 bg-zinc-900/70 py-2"
    >
      <button
        type="button"
        aria-label="导入 EPUB"
        title="导入 EPUB"
        onClick={handleImport}
        disabled={importing}
        className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-50"
      >
        <LibraryBig size={18} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="切换主侧栏"
        aria-pressed={primarySidebarVisible}
        title={primarySidebarVisible ? '隐藏主侧栏' : '显示主侧栏'}
        onClick={handleTogglePrimarySidebar}
        className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
      >
        {primarySidebarVisible ? (
          <PanelLeftClose size={18} aria-hidden />
        ) : (
          <PanelLeftOpen size={18} aria-hidden />
        )}
      </button>
    </nav>
  );
}
