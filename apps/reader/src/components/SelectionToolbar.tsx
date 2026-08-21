import { useEffect, useRef, useState } from 'react';
import { Highlighter, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import {
  getSingleSectionSelectionError,
} from '../domain/annotation/textAnchor';
import type { AreaSelection } from '../domain/reader/bookDocument';
import { useReaderRuntime } from '../workbench/readerRuntime';

type SelectionState =
  | {
      kind: 'text';
      range: Range;
      ownerDocument: Document;
      x: number;
      y: number;
      invalidReason?: string;
    }
  | { kind: 'area'; area: AreaSelection; x: number; y: number };

/**
 * 阅读视图内的选择工具栏:当用户在正文(content iframe)选中文本时,在选区上方
 * 显示「高亮」与「取消」。选区 Range 属于 Reader Runtime(活对象),只在本组件
 * 内临时持有,不进入任何持久化状态。
 *
 * 内容文档位于 foliate 的 iframe 内,因此需要把标记的选区监听器附加到每个内容
 * document,并把 iframe 内坐标换算到父视口坐标来定位工具栏。
 */
export function SelectionToolbar({ viewId }: { viewId: string }) {
  const { commands } = useAppServices();
  const document_ = useReaderRuntime((state) => state.documents.get(viewId));
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  // 监听内容文档的 selectionchange,在非空选区时读取 Range 并计算父视口坐标。
  useEffect(() => {
    const book = useReaderRuntime.getState().getDocument(viewId);
    if (!book) return;

    const detachList: Array<() => void> = [];
    const handleSelection = (doc: Document) => () => {
      const sel = doc.getSelection?.();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        setPosition(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelection(null);
        setPosition(null);
        return;
      }
      // 把 iframe 内坐标换算到父视口:叠加 iframe 帧的偏移。
      const frame = doc.defaultView?.frameElement as HTMLElement | null;
      const frameRect = frame?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const x = frameRect.left + rect.left + rect.width / 2;
      const y = frameRect.top + rect.top;
      const invalidReason =
        book.format === 'epub'
          ? getSingleSectionSelectionError(
              range,
              (contentDocument) => book.getContentDocumentIndex?.(contentDocument) ?? null,
            )
          : null;
      setSelection({
        kind: 'text',
        range,
        ownerDocument: doc,
        x,
        y,
        ...(invalidReason ? { invalidReason } : {}),
      });
      setPosition({ x, y });
    };

    const attachDoc = (doc: Document) => {
      const handler = handleSelection(doc);
      doc.addEventListener('selectionchange', handler);
      doc.addEventListener('mouseup', handler);
      detachList.push(() => {
        doc.removeEventListener('selectionchange', handler);
        doc.removeEventListener('mouseup', handler);
      });
    };
    for (const doc of book.getContentDocs()) {
      attachDoc(doc);
    }
    const offContentCreate = book.onContentCreate(attachDoc);
    const offAreaSelection = book.onAreaSelection?.((area) => {
      const x = area.clientRect.left + area.clientRect.width / 2;
      const y = area.clientRect.top;
      setSelection({ kind: 'area', area, x, y });
      setPosition({ x, y });
    });

    return () => {
      offContentCreate();
      offAreaSelection?.();
      for (const detach of detachList) {
        detach();
      }
    };
  }, [viewId, document_]);

  // 工具栏渲染后把自身定位到选区上方中间。
  useEffect(() => {
    if (!selection || !toolbarRef.current) return;
    const rect = toolbarRef.current.getBoundingClientRect();
    setPosition({ x: selection.x, y: selection.y - rect.height - 10 });
  }, [selection]);

  if (!selection || !position) {
    return null;
  }

  const handleHighlight = async () => {
    if (selection.kind === 'text' && selection.invalidReason) return;
    const command =
      selection.kind === 'area'
        ? commands.execute(COMMAND_IDS.annotationCreatePdfArea, viewId, selection.area)
        : commands.execute(COMMAND_IDS.annotationCreateHighlight, viewId, selection.range);
    await command.catch((error: unknown) => console.error('创建高亮失败', error));
    setSelection(null);
    setPosition(null);
    if (selection.kind === 'text') {
      selection.ownerDocument.getSelection?.()?.removeAllRanges();
    }
  };

  const handleCancel = () => {
    setSelection(null);
    setPosition(null);
    if (selection?.kind === 'text') {
      selection.ownerDocument.getSelection?.()?.removeAllRanges();
    }
  };

  return (
    <div
      ref={toolbarRef}
      className="pointer-events-auto fixed z-50 flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-1.5 py-1 shadow-lg"
      style={{ left: position.x, top: position.y, transform: 'translateX(-50%)' }}
      role="toolbar"
      aria-label="选区工具栏"
    >
      {selection.kind === 'text' && selection.invalidReason ? (
        <span role="alert" className="max-w-64 px-2 py-1 text-xs leading-5 text-amber-200">
          {selection.invalidReason}
        </span>
      ) : (
        <button
          type="button"
          onClick={handleHighlight}
          aria-label={selection.kind === 'area' ? '高亮选中区域' : '高亮选中文本'}
          className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-zinc-700"
        >
          <Highlighter size={14} aria-hidden />
          {selection.kind === 'area' ? '高亮区域' : '高亮'}
        </button>
      )}
      <button
        type="button"
        onClick={handleCancel}
        aria-label="取消选择"
        className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
