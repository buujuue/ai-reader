import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryImportRepository } from '../domain/library/inMemoryImportRepository';
import type { BookDocument } from '../domain/reader/bookDocument';
import type { ReadingLocation } from '../domain/reader/readingLocation';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { createAppServices } from '../app/bootstrap';
import { AppServicesProvider } from '../app/AppServicesContext';
import { createInMemoryFilePicker } from '../app/filePicker';
import { buildReaderRuntimeCacheKey } from '../workbench/readerRuntimeCache';
import { useLibraryStore } from '../workbench/libraryStore';
import { flushAndCloseAllReaderViews } from '../workbench/readerCommands';
import { useReaderRuntime } from '../workbench/readerRuntime';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { ReadingView } from './ReadingView';

function makeMaterial() {
  return {
    id: 'material-hidden-group',
    fingerprint: 'fingerprint-hidden-group',
    sourceFileName: 'hidden-group.epub',
    folderId: null,
    source: { title: '隐藏组材料', author: null, language: 'zh' },
    override: { title: null, author: null, coverSource: null },
    title: '隐藏组材料',
    author: null,
    language: 'zh',
    coverSource: null,
    documentVersion: 0,
  };
}

function makeBook(contentDocument: Document) {
  const listeners = new Set<(location: ReadingLocation) => void>();
  let location: ReadingLocation | null = null;
  return {
    format: 'epub' as const,
    metadata: { title: '隐藏组材料', author: null, language: 'zh' },
    open: vi.fn(async () => undefined),
    attach: vi.fn(() => true),
    detach: vi.fn(async () => undefined),
    isRuntimeReady: () => true,
    getLocation: () => location,
    goToLocation: vi.fn(async (next: ReadingLocation) => {
      location = next;
      for (const listener of listeners) listener(next);
    }),
    goToHref: vi.fn(async () => undefined),
    getTOC: () => [],
    async *search() {},
    clearSearch: vi.fn(),
    applyTypography: vi.fn(),
    next: vi.fn(async () => undefined),
    prev: vi.fn(async () => undefined),
    getCFI: () => '',
    getCurrentIndex: () => 0,
    addAnnotation: vi.fn(),
    removeAnnotation: vi.fn(),
    onShowAnnotation: () => () => undefined,
    onInternalLink: () => () => undefined,
    onExternalLink: () => () => undefined,
    getContentDocs: () => [contentDocument],
    onContentCreate: () => () => undefined,
    onLocationChange: (listener: (next: ReadingLocation) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: vi.fn(),
  } as unknown as BookDocument & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

describe('ReadingView 可见性与 Runtime 生命周期', () => {
  beforeEach(async () => {
    await flushAndCloseAllReaderViews();
    useWorkspaceStore.getState().resetToDefault();
    useLibraryStore.getState().resetToDefault();
    useReaderRuntime.getState().closeAll();
  });

  it('紧凑布局隐藏组时清理输入并挂起，重新显示后复用同一 Runtime', async () => {
    const material = makeMaterial();
    const contentDocument = document.implementation.createHTMLDocument('隐藏组正文');
    const addEventListener = vi.spyOn(contentDocument, 'addEventListener');
    const removeEventListener = vi.spyOn(contentDocument, 'removeEventListener');
    const book = makeBook(contentDocument);
    const viewId = useWorkspaceStore.getState().openView(material.id);
    const workspaceRepository = createInMemoryWorkspaceRepository();
    const importRepository = createInMemoryImportRepository(new Map());
    importRepository.listMaterials = vi.fn(async () => [material]);
    const services = createAppServices({
      importRepository,
      filePicker: createInMemoryFilePicker([]),
      workspaceRepository,
    });

    useLibraryStore.setState({ materials: [material], trashedMaterials: [] });
    useReaderRuntime.getState().setDocument(viewId, book, {
      lifecycle: 'active',
      cacheKey: buildReaderRuntimeCacheKey({
        viewId,
        materialId: material.id,
        contentFingerprint: material.fingerprint,
        documentVersion: material.documentVersion,
        format: 'epub',
      }),
    });

    const view = render(
      <AppServicesProvider services={services}>
        <ReadingView viewId={viewId} />
      </AppServicesProvider>,
    );
    await waitFor(() => expect(addEventListener).toHaveBeenCalled());

    view.rerender(
      <AppServicesProvider services={services}>
        <ReadingView viewId={viewId} visible={false} />
      </AppServicesProvider>,
    );

    await waitFor(() => {
      expect(book.detach).toHaveBeenCalledOnce();
      expect(useReaderRuntime.getState().getDocumentLifecycle(viewId)).toBe('suspended');
    });
    expect(removeEventListener).toHaveBeenCalled();

    view.rerender(
      <AppServicesProvider services={services}>
        <ReadingView viewId={viewId} visible />
      </AppServicesProvider>,
    );

    await waitFor(() => {
      expect(useReaderRuntime.getState().getDocumentLifecycle(viewId)).toBe('active');
      expect(book.attach).toHaveBeenCalledTimes(2);
    });
    expect(useReaderRuntime.getState().getDocument(viewId)).toBe(book);
    expect(addEventListener.mock.calls.length).toBeGreaterThan(1);

    view.unmount();
    await flushAndCloseAllReaderViews();
  });
});
