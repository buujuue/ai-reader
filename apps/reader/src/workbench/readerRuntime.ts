import { create } from 'zustand';

import type { BookDocument } from '../domain/reader/bookDocument';

/**
 * Reader Runtime:不可持久化的活对象集合。它按阅读视图 id 持有 BookDocument
 * (内部是 Foliate View 等渲染器)。工作区标签、阅读位置等可序列化状态
 * 属于 Workspace Store,绝不进入本 Store。
 */
export interface ReaderRuntimeState {
  documents: Map<string, BookDocument>;
  setDocument: (viewId: string, document: BookDocument) => void;
  getDocument: (viewId: string) => BookDocument | undefined;
  removeDocument: (viewId: string) => void;
  closeAll: () => void;
}

export const useReaderRuntime = create<ReaderRuntimeState>()((set, get) => ({
  documents: new Map(),

  setDocument: (viewId, document) => {
    set((state) => {
      const documents = new Map(state.documents);
      documents.set(viewId, document);
      return { documents };
    });
  },

  getDocument: (viewId) => get().documents.get(viewId),

  removeDocument: (viewId) => {
    const document = get().documents.get(viewId);
    document?.close();
    set((state) => {
      const documents = new Map(state.documents);
      documents.delete(viewId);
      return { documents };
    });
  },

  closeAll: () => {
    const documents = get().documents;
    for (const document of documents.values()) {
      document.close();
    }
    set({ documents: new Map() });
  },
}));