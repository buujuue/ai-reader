import { Palette, Settings2 } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { getWorkbenchTheme } from '../app/workbenchAppearance';
import { useWorkbenchAppearanceStore } from '../workbench/appearanceStore';
import { SidebarPanelHeader } from './SidebarPanelHeader';
import { WorkbenchGlowToggle, WorkbenchThemeOptionList } from './WorkbenchAppearanceControls';

export function InterfaceSidebar() {
  const { commands } = useAppServices();
  const theme = useWorkbenchAppearanceStore((state) => state.theme);
  const glowEnabled = useWorkbenchAppearanceStore((state) => state.glowEnabled);
  const currentTheme = getWorkbenchTheme(theme);

  const setTheme = (nextTheme: typeof theme) => {
    void commands.execute(COMMAND_IDS.workbenchSetAppearanceTheme, nextTheme).catch(() => undefined);
  };

  const setGlowEnabled = () => {
    void commands
      .execute(COMMAND_IDS.workbenchSetBackgroundGlow, !glowEnabled)
      .catch(() => undefined);
  };

  return (
    <aside aria-label="界面侧栏" className="app-sidebar-panel app-interface-panel">
      <SidebarPanelHeader icon={Settings2} title="界面" />
      <div className="app-interface-panel-content">
        <section aria-labelledby="interface-appearance-title" className="app-interface-appearance">
          <div className="app-interface-appearance-heading">
            <span className="app-interface-appearance-icon" aria-hidden>
              <Palette size={16} />
            </span>
            <div>
              <p className="app-interface-panel-eyebrow">工作台外观</p>
              <h3 id="interface-appearance-title">主题配色</h3>
            </div>
            <span className="app-interface-appearance-current">{currentTheme.label}</span>
          </div>
          <p className="app-interface-appearance-description">
            只改变工作台外壳，不会改变阅读材料的正文主题。
          </p>
          <WorkbenchThemeOptionList theme={theme} onSelect={setTheme} />
          <WorkbenchGlowToggle glowEnabled={glowEnabled} onChange={setGlowEnabled} />
        </section>
        <p className="app-interface-panel-note" role="note">
          外观偏好保存在本机，刷新或重启后会自动恢复；完整书库备份不会覆盖它。
        </p>
      </div>
    </aside>
  );
}
