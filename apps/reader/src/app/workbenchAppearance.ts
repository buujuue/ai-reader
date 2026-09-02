export type WorkbenchThemeId = 'midnight' | 'apple' | 'claude' | 'mint' | 'rose';

export interface WorkbenchTheme {
  id: WorkbenchThemeId;
  label: string;
  description: string;
}

export const WORKBENCH_THEMES: readonly WorkbenchTheme[] = [
  { id: 'midnight', label: '极夜黑', description: '默认 · 蓝紫环境光' },
  { id: 'apple', label: '苹果白', description: '通透冷白 · 系统蓝' },
  { id: 'claude', label: 'Claude 护眼', description: '暖纸米色 · 陶土橙' },
  { id: 'mint', label: '清新绿', description: '低饱和绿 · 自然呼吸感' },
  { id: 'rose', label: '柔雾粉', description: '克制豆沙粉 · 柔和安静' },
];

export interface WorkbenchAppearance {
  theme: WorkbenchThemeId;
  glowEnabled: boolean;
}

export const DEFAULT_WORKBENCH_APPEARANCE: WorkbenchAppearance = Object.freeze({
  theme: 'midnight',
  glowEnabled: true,
});

export const WORKBENCH_APPEARANCE_STORAGE_KEY = 'ai-reader.workbench-appearance';

export interface WorkbenchAppearancePreferences {
  load: () => WorkbenchAppearance;
  save: (appearance: WorkbenchAppearance) => void;
}

export function isWorkbenchThemeId(value: unknown): value is WorkbenchThemeId {
  return WORKBENCH_THEMES.some((theme) => theme.id === value);
}

export function normalizeWorkbenchAppearance(raw: unknown): WorkbenchAppearance {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_WORKBENCH_APPEARANCE };
  }

  const candidate = raw as Partial<WorkbenchAppearance>;
  if (!isWorkbenchThemeId(candidate.theme) || typeof candidate.glowEnabled !== 'boolean') {
    return { ...DEFAULT_WORKBENCH_APPEARANCE };
  }
  return {
    theme: candidate.theme,
    glowEnabled: candidate.glowEnabled,
  };
}

export function getWorkbenchTheme(theme: WorkbenchThemeId): WorkbenchTheme {
  return WORKBENCH_THEMES.find((option) => option.id === theme) ?? WORKBENCH_THEMES[0]!;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function createInMemoryWorkbenchAppearancePreferences(
  initial: WorkbenchAppearance = DEFAULT_WORKBENCH_APPEARANCE,
): WorkbenchAppearancePreferences {
  let stored = normalizeWorkbenchAppearance(initial);
  return {
    load: () => ({ ...stored }),
    save: (appearance) => {
      stored = normalizeWorkbenchAppearance(appearance);
    },
  };
}

export function createLocalStorageWorkbenchAppearancePreferences(
  storage: StorageLike | null | undefined = getBrowserStorage(),
): WorkbenchAppearancePreferences {
  return {
    load: () => {
      if (!storage) return { ...DEFAULT_WORKBENCH_APPEARANCE };
      try {
        const serialized = storage.getItem(WORKBENCH_APPEARANCE_STORAGE_KEY);
        return serialized
          ? normalizeWorkbenchAppearance(JSON.parse(serialized) as unknown)
          : { ...DEFAULT_WORKBENCH_APPEARANCE };
      } catch {
        return { ...DEFAULT_WORKBENCH_APPEARANCE };
      }
    },
    save: (appearance) => {
      if (!storage) return;
      storage.setItem(
        WORKBENCH_APPEARANCE_STORAGE_KEY,
        JSON.stringify(normalizeWorkbenchAppearance(appearance)),
      );
    },
  };
}

/** 在 React 首次绘制前同步设置根节点属性，避免外壳先以错误配色闪现。 */
export function applyWorkbenchAppearanceToDocument(appearance: WorkbenchAppearance): void {
  if (typeof document === 'undefined') return;
  const normalized = normalizeWorkbenchAppearance(appearance);
  document.documentElement.dataset.workbenchTheme = normalized.theme;
  document.documentElement.dataset.workbenchGlow = normalized.glowEnabled ? 'on' : 'off';
}
