import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface SidebarPanelHeaderProps {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
}

/**
 * 左侧活动面板共用的固定顶栏结构。
 * 标题组和操作组始终占据稳定的网格位置，避免书库与目录各自调整间距后产生偏移。
 */
export function SidebarPanelHeader({ icon: Icon, title, action }: SidebarPanelHeaderProps) {
  return (
    <div className="sidebar-panel-header">
      <div className="sidebar-panel-header-title">
        <Icon size={16} aria-hidden className="shrink-0 text-zinc-400" />
        <h2>{title}</h2>
      </div>
      <div className="sidebar-panel-header-actions" aria-hidden={action ? undefined : true}>
        {action}
      </div>
    </div>
  );
}
