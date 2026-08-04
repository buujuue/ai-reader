import { create } from 'zustand';

/** 外壳运行时反馈(状态栏文案等),不参与持久化。 */
export interface ShellUiStoreState {
  statusMessage: string;
  setStatusMessage: (message: string) => void;
  clearStatusMessage: () => void;
}

export const useShellUiStore = create<ShellUiStoreState>()((set) => ({
  statusMessage: '',
  setStatusMessage: (message) => set({ statusMessage: message }),
  clearStatusMessage: () => set({ statusMessage: '' }),
}));
