import { create } from 'zustand';

import type { BookDocument } from '../domain/reader/bookDocument';

export type ReaderDocumentStatus =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

export type ReaderRuntimeLifecycle = 'active' | 'suspended';

/**
 * Reader Runtime:不可持久化的活对象集合。它按阅读视图 id 持有 BookDocument
 * (内部是 Foliate View 等渲染器)。工作区标签、阅读位置等可序列化状态
 * 属于 Workspace Store,绝不进入本 Store。
 */
export interface ReaderRuntimeState {
  documents: Map<string, BookDocument>;
  documentStates: Map<string, ReaderDocumentStatus>;
  documentLifecycles: Map<string, ReaderRuntimeLifecycle>;
  documentCacheKeys: Map<string, string>;
  setDocument: (
    viewId: string,
    document: BookDocument,
    options?: { lifecycle?: ReaderRuntimeLifecycle; cacheKey?: string },
  ) => void;
  setDocumentLifecycle: (viewId: string, lifecycle: ReaderRuntimeLifecycle) => void;
  getDocumentLifecycle: (viewId: string) => ReaderRuntimeLifecycle | undefined;
  getDocumentCacheKey: (viewId: string) => string | undefined;
  setDocumentState: (viewId: string, state: ReaderDocumentStatus) => void;
  getDocument: (viewId: string) => BookDocument | undefined;
  removeDocument: (viewId: string, options?: { close?: boolean }) => void;
  closeAll: () => void;
}

export const useReaderRuntime = create<ReaderRuntimeState>()((set, get) => ({
  documents: new Map(),
  documentStates: new Map(),
  documentLifecycles: new Map(),
  documentCacheKeys: new Map(),

  setDocument: (viewId, document, options) => {
    set((state) => {
      const documents = new Map(state.documents);
      documents.set(viewId, document);
      const documentStates = new Map(state.documentStates);
      documentStates.set(viewId, { status: 'idle' });
      const documentLifecycles = new Map(state.documentLifecycles);
      documentLifecycles.set(viewId, options?.lifecycle ?? 'active');
      const documentCacheKeys = new Map(state.documentCacheKeys);
      if (options?.cacheKey) documentCacheKeys.set(viewId, options.cacheKey);
      else documentCacheKeys.delete(viewId);
      return { documents, documentStates, documentLifecycles, documentCacheKeys };
    });
  },

  setDocumentLifecycle: (viewId, lifecycle) => {
    set((state) => {
      if (!state.documents.has(viewId)) return state;
      const documentLifecycles = new Map(state.documentLifecycles);
      documentLifecycles.set(viewId, lifecycle);
      return { documentLifecycles };
    });
  },

  getDocumentLifecycle: (viewId) => {
    const lifecycle = get().documentLifecycles.get(viewId);
    return lifecycle ?? (get().documents.has(viewId) ? 'active' : undefined);
  },

  getDocumentCacheKey: (viewId) => get().documentCacheKeys.get(viewId),

  setDocumentState: (viewId, documentState) => {
    set((state) => {
      const documentStates = new Map(state.documentStates);
      documentStates.set(viewId, documentState);
      return { documentStates };
    });
  },

  getDocument: (viewId) => get().documents.get(viewId),

  removeDocument: (viewId, options) => {
    const document = get().documents.get(viewId);
    if (options?.close !== false) document?.close();
    set((state) => {
      const documents = new Map(state.documents);
      documents.delete(viewId);
      const documentStates = new Map(state.documentStates);
      documentStates.delete(viewId);
      const documentLifecycles = new Map(state.documentLifecycles);
      documentLifecycles.delete(viewId);
      const documentCacheKeys = new Map(state.documentCacheKeys);
      documentCacheKeys.delete(viewId);
      return { documents, documentStates, documentLifecycles, documentCacheKeys };
    });
  },

  closeAll: () => {
    const documents = get().documents;
    for (const document of documents.values()) {
      document.close();
    }
    set({
      documents: new Map(),
      documentStates: new Map(),
      documentLifecycles: new Map(),
      documentCacheKeys: new Map(),
    });
  },
}));
