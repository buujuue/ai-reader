import { Settings2 } from 'lucide-react';

import { SidebarPanelHeader } from './SidebarPanelHeader';

/**
 * 界面活动面板的生产壳。面板开关和响应式呈现由 App/Workspace Command 负责；
 * 具体外观与阅读排版控件在后续设置切片中接入此面板，避免另起侧栏或对话框。
 */
export function InterfaceSidebar() {
  return (
    <aside aria-label="界面侧栏" className="app-sidebar-panel app-interface-panel">
      <SidebarPanelHeader icon={Settings2} title="界面" />
      <div className="app-interface-panel-content">
        <section aria-labelledby="interface-panel-title" className="app-interface-panel-intro">
          <p className="app-interface-panel-eyebrow">显示与阅读</p>
          <h3 id="interface-panel-title">界面设置</h3>
          <p>工作台外观和阅读排版将在这里集中管理。</p>
        </section>
        <p className="app-interface-panel-note" role="note">
          面板设置会沿用当前工作区的恢复与响应式行为。
        </p>
      </div>
    </aside>
  );
}
