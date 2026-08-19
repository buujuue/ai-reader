/**
 * 阅读器向工作台暴露的可序列化位置反馈。
 *
 * 这不是恢复阅读所用的锚点；恢复仍只依赖 ReadingLocation/CFI。
 * 这里保留 foliate 的进度事实，供状态栏、无障碍文本和后续页面指示器使用。
 */
export interface ReadingProgress {
  /** 全书进度，范围为 0 到 1；无法计算时为 null。 */
  fraction: number | null;
  /** 当前章节序号与章节总数，序号从 0 开始。 */
  section: { current: number; total: number } | null;
  /** foliate 的位置单位进度；没有可用定位信息时为 null。 */
  location: { current: number; next: number; total: number } | null;
  /** 当前目录项的用户可见标题。 */
  tocLabel: string | null;
  /** 当前书页标签（若 EPUB 提供 page-list/NXC page target）。 */
  pageLabel: string | null;
}

export function clampProgressFraction(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function readCounter(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function readSection(value: unknown): ReadingProgress['section'] {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { current?: unknown; total?: unknown };
  const current = readCounter(candidate.current);
  const total = readCounter(candidate.total);
  if (current === null || total === null || total <= 0 || current >= total) return null;
  return { current, total };
}

function readLocation(value: unknown): ReadingProgress['location'] {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { current?: unknown; next?: unknown; total?: unknown };
  const current = readCounter(candidate.current);
  const next = readCounter(candidate.next);
  const total = readCounter(candidate.total);
  if (current === null || next === null || total === null || total <= 0) return null;
  return { current, next: Math.max(current, next), total };
}

function readLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const label = (value as { label?: unknown }).label;
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  return trimmed || null;
}

/**
 * 将 foliate `lastLocation` 的开放对象收敛为稳定的领域数据。
 * 不把 Range 或渲染器对象带出 Adapter，避免污染可序列化工作区状态。
 */
export function normalizeReadingProgress(value: unknown): ReadingProgress | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    fraction?: unknown;
    section?: unknown;
    location?: unknown;
    tocItem?: unknown;
    pageItem?: unknown;
  };
  const progress: ReadingProgress = {
    fraction: clampProgressFraction(candidate.fraction),
    section: readSection(candidate.section),
    location: readLocation(candidate.location),
    tocLabel: readLabel(candidate.tocItem),
    pageLabel: readLabel(candidate.pageItem),
  };
  return progress.fraction === null &&
    progress.section === null &&
    progress.location === null &&
    progress.tocLabel === null &&
    progress.pageLabel === null
    ? null
    : progress;
}

export function formatReadingProgress(progress: ReadingProgress | null): string {
  if (!progress) return '位置待定';
  const percent = progress.fraction === null ? null : Math.round(progress.fraction * 100);
  const chapter = progress.section
    ? `第 ${progress.section.current + 1}/${progress.section.total} 节`
    : null;
  const page = progress.pageLabel ??
    (progress.location && progress.location.total > 0
      ? `位置 ${Math.min(progress.location.current + 1, progress.location.total)}/${progress.location.total}`
      : null);
  const label = progress.tocLabel ?? chapter ?? page;
  if (percent === null) return label ?? '位置待定';
  return label ? `${percent}% · ${label}` : `${percent}%`;
}
