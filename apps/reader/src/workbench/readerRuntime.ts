import { create } from 'zustand';

import type { BookDocument } from '../domain/reader/bookDocument';

export type ReaderDocumentStatus =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

/**
 * Reader Runtime:不可持久化的活对象集合。它按阅读视图 id 持有 BookDocument
 * (内部是 Foliate View 等渲染器)。工作区标签、阅读位置等可序列化状态
 * 属于 Workspace Store,绝不进入本 Store。
 */
export interface ReaderRuntimeState {
  documents: Map<string, BookDocument>;
  documentStates: Map<string, ReaderDocumentStatus>;
  setDocument: (viewId: string, document: BookDocument) => void;
  setDocumentState: (viewId: string, state: ReaderDocumentStatus) => void;
  getDocument: (viewId: string) => BookDocument | undefined;
  removeDocument: (viewId: string) => void;
  closeAll: () => void;
}

export const useReaderRuntime = create<ReaderRuntimeState>()((set, get) => ({
  documents: new Map(),
  documentStates: new Map(),

  setDocument: (viewId, document) => {
    set((state) => {
      const documents = new Map(state.documents);
      documents.set(viewId, document);
      const documentStates = new Map(state.documentStates);
      documentStates.set(viewId, { status: 'idle' });
      return { documents, documentStates };
    });
  },

  setDocumentState: (viewId, documentState) => {
    set((state) => {
      const documentStates = new Map(state.documentStates);
      documentStates.set(viewId, documentState);
      return { documentStates };
    });
  },

  getDocument: (viewId) => get().documents.get(viewId),

  removeDocument: (viewId) => {
    const document = get().documents.get(viewId);
    document?.close();
    set((state) => {
      const documents = new Map(state.documents);
      documents.delete(viewId);
      const documentStates = new Map(state.documentStates);
      documentStates.delete(viewId);
      return { documents, documentStates };
    });
  },

  closeAll: () => {
    const documents = get().documents;
    for (const document of documents.values()) {
      document.close();
    }
    set({ documents: new Map(), documentStates: new Map() });
  },
}));
