import { useEffect, useState, type RefObject } from 'react';

export const COMPACT_LAYOUT_MAX_WIDTH = 800;
export const WIDE_LAYOUT_MIN_WIDTH = 1200;

export type LayoutMode = 'compact' | 'medium' | 'wide';
export type SidebarPresentation = 'inline' | 'overlay';
export type SidebarId = 'toc' | 'primary' | 'interface';

export interface SidebarVisibility {
  toc: boolean;
  primary: boolean;
  interface: boolean;
}

/**
 * 根据工作台容器的真实宽度计算布局策略。
 *
 * 这是派生视图策略，不会改写 Workspace Store，因此紧凑布局隐藏编辑器组或侧栏
 * 时，用户的持久化期望状态仍然保持不变；容器恢复宽度后可以直接重新显示。
 */
export interface LayoutPolicy {
  mode: LayoutMode;
  sidebarPresentation: SidebarPresentation;
  showAllEditorGroups: boolean;
}

/**
 * 把持久化的侧栏期望状态投影到当前容器，避免中等宽度和紧凑抽屉互相重叠。
 * 所有布局都只显示一个侧栏；布局只改变呈现方式，不修改持久化期望状态。
 */
export function getVisibleSidebars(
  policy: LayoutPolicy,
  visibility: SidebarVisibility,
  preferredSidebar: SidebarId = 'primary',
): SidebarId[] {
  const requested: SidebarId[] = [preferredSidebar];
  for (const sidebar of ['primary', 'toc', 'interface'] as const) {
    if (sidebar !== preferredSidebar) requested.push(sidebar);
  }
  const visible = requested.filter((sidebar) => visibility[sidebar]);
  return visible.slice(0, 1);
}

export function getLayoutPolicy(width: number): LayoutPolicy {
  const normalizedWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const mode: LayoutMode =
    normalizedWidth < COMPACT_LAYOUT_MAX_WIDTH
      ? 'compact'
      : normalizedWidth < WIDE_LAYOUT_MIN_WIDTH
        ? 'medium'
        : 'wide';

  return {
    mode,
    sidebarPresentation: mode === 'compact' ? 'overlay' : 'inline',
    showAllEditorGroups: mode !== 'compact',
  };
}

function getInitialWidth(): number {
  if (typeof window === 'undefined') return WIDE_LAYOUT_MIN_WIDTH;
  return window.innerWidth || WIDE_LAYOUT_MIN_WIDTH;
}

/**
 * 监听工作台容器宽度。iPadOS 分屏、旋转和窗口尺寸变化都会经过同一条路径。
 * ResizeObserver 不存在时退回 window.resize，便于旧 WebView 与测试环境运行。
 */
export function useLayoutPolicy(
  containerRef: RefObject<HTMLElement | null>,
): LayoutPolicy {
  const [width, setWidth] = useState(getInitialWidth);

  useEffect(() => {
    const container = containerRef.current;
    const readWidth = () => {
      const nextWidth = container?.getBoundingClientRect().width || container?.clientWidth || getInitialWidth();
      setWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    readWidth();
    if (container && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(readWidth);
      observer.observe(container);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', readWidth);
    return () => window.removeEventListener('resize', readWidth);
  }, [containerRef]);

  return getLayoutPolicy(width);
}
