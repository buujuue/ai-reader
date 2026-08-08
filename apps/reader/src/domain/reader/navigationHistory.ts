import type { ReadingLocation } from './readingLocation';

/** 每个 ReadingView 最多保留的导航历史节点数。 */
export const MAX_NAVIGATION_HISTORY = 50;

/**
 * 导航历史:每个 ReadingView 的可序列化位置栈。
 * 它是纯数据结构,不依赖渲染器活对象,可随工作区状态持久化并在重启后恢复。
 *
 * 语义(见规格):
 * - 显式跳转(目录、书内链接、搜索结果、批注)通过 `pushExplicit` 新增节点。
 * - 普通翻页或滚动只通过 `replaceCurrent` 替换当前节点,不制造无意义的后退步骤。
 * - 节点数超过上限时丢弃最旧节点。
 */
export interface NavigationHistory {
  positions: ReadingLocation[];
  index: number;
}

export function createNavigationHistory(): NavigationHistory {
  return { positions: [], index: -1 };
}

/** 当前历史节点对应的阅读位置;空历史返回 null。 */
export function currentLocation(history: NavigationHistory): ReadingLocation | null {
  return history.index >= 0 ? (history.positions[history.index] ?? null) : null;
}

/**
 * 显式跳转:先截断已前进的分支,再在当前位置后新增节点,并把索引指向新节点。
 * 超过上限时丢弃最旧节点。
 */
export function pushExplicit(history: NavigationHistory, location: ReadingLocation): NavigationHistory {
  const positions = [...history.positions.slice(0, history.index + 1), location];
  if (positions.length > MAX_NAVIGATION_HISTORY) {
    positions.shift();
  }
  return { positions, index: positions.length - 1 };
}

/** 普通翻页/滚动:只替换当前节点;空历史时等同新增。 */
export function replaceCurrent(history: NavigationHistory, location: ReadingLocation): NavigationHistory {
  if (history.index < 0 || history.positions.length === 0) {
    return pushExplicit(history, location);
  }
  const positions = [...history.positions];
  positions[history.index] = location;
  return { positions, index: history.index };
}

export function canGoBack(history: NavigationHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: NavigationHistory): boolean {
  return history.index >= 0 && history.index < history.positions.length - 1;
}

/** 后退一步;无前一个节点时返回 null。 */
export function back(history: NavigationHistory): { history: NavigationHistory; location: ReadingLocation } | null {
  if (!canGoBack(history)) {
    return null;
  }
  const location = history.positions[history.index - 1]!;
  return { history: { ...history, index: history.index - 1 }, location };
}

/** 前进一步;无下一个节点时返回 null。 */
export function forward(history: NavigationHistory): { history: NavigationHistory; location: ReadingLocation } | null {
  if (!canGoForward(history)) {
    return null;
  }
  const location = history.positions[history.index + 1]!;
  return { history: { ...history, index: history.index + 1 }, location };
}