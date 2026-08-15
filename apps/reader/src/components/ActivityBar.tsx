import { LibraryBig, ListTree } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';

/** 一级区域入口只保留书库和目录;导入、备份等低频动作位于应用顶栏菜单。 */
export function ActivityBar() {
  const { commands } = useAppServices();
  const primarySidebarVisible = useWorkspaceStore((state) => state.primarySidebarVisible);
  const tocVisible = useWorkspaceStore((state) => state.tocVisible);
  const compactActivityPanelDismissed = useShellUiStore(
    (state) => state.compactActivityPanelDismissed,
  );

  const toggleLibrary = () => {
    void commands.execute(COMMAND_IDS.workbenchTogglePrimarySidebar).catch(() => undefined);
  };

  const toggleToc = () => {
    void commands.execute(COMMAND_IDS.workbenchToggleToc).catch(() => undefined);
  };

  return (
    <nav aria-label="活动栏" className="app-activity-rail frosted-zone">
      <button
        type="button"
        aria-label="书库"
        aria-pressed={primarySidebarVisible && !compactActivityPanelDismissed}
        title={primarySidebarVisible ? '隐藏书库' : '显示书库'}
        onClick={toggleLibrary}
        className="app-activity-button"
      >
        <LibraryBig size={20} aria-hidden />
        <span>书库</span>
      </button>
      <button
        type="button"
        aria-label="目录"
        aria-pressed={tocVisible && !compactActivityPanelDismissed}
        title={tocVisible ? '隐藏目录' : '显示目录'}
        onClick={toggleToc}
        className="app-activity-button"
      >
        <ListTree size={20} aria-hidden />
        <span>目录</span>
      </button>
    </nav>
  );
}
