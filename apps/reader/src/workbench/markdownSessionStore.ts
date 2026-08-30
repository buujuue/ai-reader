import { create } from 'zustand';

/**
 * Markdown 文档会话(ADR-0009):同一 BookId 只有一个会话,唯一 ReadingView
 * 使用一个未保存缓冲区,并独立保存阅读位置与源码/阅读模式。
 *
 * 本 Store 持有会话的活对象状态(源文本、脏标记、已保存文档版本),用于驱动
 * 源码编辑器与保存/放弃流程。它不参与持久化:正式保存由 Rust 原子替换托管文件,
 * 缓存的位置与模式仍由 Workspace Store 负责。
 */

/** 一个 Markdown 材料的会话。以 BookId(materialId)为键。 */
export interface MarkdownDocumentSession {
  /** 归属的阅读材料 BookId。 */
  materialId: string;
  /** 当前未保存缓冲区文本。 */
  text: string;
  /** 是否相对上次正式保存有未保存修改。 */
  dirty: boolean;
  /** 上次正式保存时材料文档版本(用于冲突判断与保存后比对)。 */
  savedVersion: number;
}

export interface MarkdownSessionStoreState {
  /** BookId → 会话。同一材料只有一个会话,视图共享。 */
  sessions: Record<string, MarkdownDocumentSession>;
  /** 打开/恢复一个会话(幂等:已存在则保留现有缓冲区)。 */
  openSession: (
    materialId: string,
    text: string,
    savedVersion: number,
  ) => void;
  /** 用当前托管正文替换版本不一致的会话,清除旧的脏缓冲区。 */
  replaceFormalText: (materialId: string, text: string, savedVersion: number) => void;
  /** 更新缓冲区文本并标记为脏。 */
  updateText: (materialId: string, text: string) => void;
  /** 记录正式保存结果；仅当缓冲区仍等于本次保存文本时清除脏标记。 */
  recordFormalSave: (
    materialId: string,
    savedText: string,
    savedVersion: number,
  ) => boolean;
  /** 放弃未保存修改:让缓冲区回到最后一次正式保存的文本。 */
  discard: (materialId: string, savedText: string) => void;
  /** 用户确认恢复快照后,把快照载入共享脏缓冲区。 */
  restoreRecovery: (materialId: string, text: string, savedVersion: number) => void;
  /** 永久清理材料时移除运行时 Markdown 缓冲区。 */
  removeSession: (materialId: string) => void;
  /** 读取一个会话;不存在时返回 null。 */
  getSession: (materialId: string) => MarkdownDocumentSession | null;
  resetToDefault: () => void;
}

export const useMarkdownSessionStore = create<MarkdownSessionStoreState>()(
  (set, get) => ({
    sessions: {},

    openSession: (materialId, text, savedVersion) =>
      set((state) => {
        if (state.sessions[materialId]) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [materialId]: { materialId, text, dirty: false, savedVersion },
          },
        };
      }),

    replaceFormalText: (materialId, text, savedVersion) =>
      set((state) => ({
        sessions: {
          ...state.sessions,
          [materialId]: { materialId, text, dirty: false, savedVersion },
        },
      })),

    updateText: (materialId, text) =>
      set((state) => {
        const session = state.sessions[materialId];
        if (!session) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [materialId]: { ...session, text, dirty: true },
          },
        };
      }),

    recordFormalSave: (materialId, savedText, savedVersion) => {
      const session = get().sessions[materialId];
      if (!session) return false;
      const unchanged = session.text === savedText;
      set((state) => ({
        sessions: {
          ...state.sessions,
          [materialId]: {
            ...state.sessions[materialId]!,
            savedVersion,
            dirty: !unchanged,
          },
        },
      }));
      return unchanged;
    },

    discard: (materialId, savedText) =>
      set((state) => {
        const session = state.sessions[materialId];
        if (!session) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [materialId]: { ...session, text: savedText, dirty: false },
          },
        };
      }),

    restoreRecovery: (materialId, text, savedVersion) =>
      set((state) => ({
        sessions: {
          ...state.sessions,
          [materialId]: { materialId, text, dirty: true, savedVersion },
        },
      })),

    removeSession: (materialId) =>
      set((state) => {
        if (!state.sessions[materialId]) return state;
        const sessions = { ...state.sessions };
        delete sessions[materialId];
        return { sessions };
      }),

    getSession: (materialId) => get().sessions[materialId] ?? null,

    resetToDefault: () => set({ sessions: {} }),
  }),
);
