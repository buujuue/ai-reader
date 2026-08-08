import { useEffect, useRef } from 'react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS, type CommandId } from '../commands/commandRegistry';
import { ReadingInputController } from '../domain/reader/readingInput';
import { useReaderRuntime } from '../workbench/readerRuntime';
import { mountViewDocument } from '../workbench/readerCommands';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { SearchBar } from './SearchBar';

/**
 * 单个阅读视图(标签)的正文区域。它把活动视图的 BookDocument 挂载到自身容器,
 * 在卸载时 flush 阅读位置并释放渲染器;同时把键盘与内容文档的输入(滚轮/点击/触摸)
 * 统一桥接到 Command Registry 的翻页命令。Reader 外部不直接操作 Foliate View。
 */
export function ReadingView({ viewId }: { viewId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { commands, importRepository, workspaceRepository } = useAppServices();
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

  // 统一阅读输入:键盘 + 内容文档(iframe 内)的滚轮/点击/触摸都收敛到同一组翻页命令。
  useEffect(() => {
    const book = useReaderRuntime.getState().getDocument(viewId);
    if (!book) return;
    const materialId = useWorkspaceStore.getState().editorGroups
      .flatMap((group) => group.views)
      .find((view) => view.id === viewId)?.materialId;
    if (!materialId) return;

    const controller = new ReadingInputController(
      {
        nextCommandId: COMMAND_IDS.readerNextPage,
        prevCommandId: COMMAND_IDS.readerPrevPage,
        execute: (commandId, targetViewId) =>
          void commands.execute(commandId as CommandId, targetViewId).catch(() => undefined),
        getFlow: () =>
          useWorkspaceStore.getState().getEffectiveTypography(materialId).flow,
      },
      viewId,
    );

    // 把输入监听器附加到每个内容文档(含后续随章节加载出现的新文档)。
    const detachList: Array<() => void> = [];
    const attachDoc = (doc: Document) => {
      detachList.push(controller.attach(doc));
    };
    for (const doc of book.getContentDocs()) {
      attachDoc(doc);
    }
    const offContentCreate = book.onContentCreate(attachDoc);

    // 应用窗口级键盘:焦点在应用内但不在内容帧时,方向键/PageUp/PageDown 翻页。
    // 焦点在输入控件时不抢占。
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      controller.handleKey({
        key: event.key,
        flow: useWorkspaceStore.getState().getEffectiveTypography(materialId).flow,
        hasModifier: event.ctrlKey || event.metaKey || event.altKey,
      });
    };
    window.addEventListener('keydown', handleWindowKeyDown);

    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
      offContentCreate();
      for (const detach of detachList) {
        detach();
      }
    };
  }, [commands, viewId, document]);

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