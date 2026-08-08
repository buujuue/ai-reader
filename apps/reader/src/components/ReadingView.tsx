import { useEffect, useRef } from 'react';

import { useAppServices } from '../app/AppServicesContext';
import { useReaderRuntime } from '../workbench/readerRuntime';
import { mountViewDocument } from '../workbench/readerCommands';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { SearchBar } from './SearchBar';

/**
 * 单个阅读视图(标签)的正文区域。它把活动视图的 BookDocument 挂载到自身容器,
 * 在卸载时 flush 阅读位置并释放渲染器。Reader 外部不直接操作 Foliate View。
 */
export function ReadingView({ viewId }: { viewId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { importRepository, workspaceRepository } = useAppServices();
  const document = useReaderRuntime((state) => state.documents.get(viewId));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const existing = useReaderRuntime.getState().getDocument(viewId);
    if (!existing) return;

    const workspace = useWorkspaceStore.getState();
    const group = workspace.editorGroups.find((g) =>
      g.views.some((view) => view.id === viewId),
    );
    const view = group?.views.find((view) => view.id === viewId);
    const persister = mountViewDocument(
      existing,
      viewId,
      container,
      view?.location ?? null,
      { importRepository, workspaceRepository },
    );
    return () => {
      // 卸载时 flush 位置并释放渲染器,但保留文档对象,便于切回标签时重新挂载。
      void persister.dispose();
      existing.close();
    };
  }, [importRepository, workspaceRepository, viewId, document]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-zinc-950">
      <SearchBar viewId={viewId} />
      <div
        ref={containerRef}
        data-view-id={viewId}
        className="h-full w-full overflow-hidden bg-zinc-950"
      />
    </div>
  );
}