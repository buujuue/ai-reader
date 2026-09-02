import { create } from 'zustand';

import {
  DEFAULT_WORKBENCH_APPEARANCE,
  normalizeWorkbenchAppearance,
  type WorkbenchAppearance,
  type WorkbenchThemeId,
} from '../app/workbenchAppearance';

export interface WorkbenchAppearanceStoreState extends WorkbenchAppearance {
  setTheme: (theme: WorkbenchThemeId) => void;
  setGlowEnabled: (enabled: boolean) => void;
  hydrate: (appearance: unknown) => void;
  resetToDefault: () => void;
}

export const useWorkbenchAppearanceStore = create<WorkbenchAppearanceStoreState>()((set) => ({
  ...DEFAULT_WORKBENCH_APPEARANCE,
  setTheme: (theme) => set({ theme }),
  setGlowEnabled: (glowEnabled) => set({ glowEnabled }),
  hydrate: (appearance) => set(normalizeWorkbenchAppearance(appearance)),
  resetToDefault: () => set({ ...DEFAULT_WORKBENCH_APPEARANCE }),
}));
