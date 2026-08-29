import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';

/**
 * 书库文件夹删除确认:明确说明子树不可恢复,但材料及其阅读数据会保留并转为未归类。
 * 只有点击确认按钮才执行删除 Command,失败时保留对话框并显示可行动错误。
 */
export function FolderDeleteConfirmDialog() {
  const { commands } = useAppServices();
  const folderDeleteId = useShellUiStore((state) => state.folderDeleteId);
  const returnFocusTarget = useShellUiStore((state) => state.folderDeleteReturnFocus);
  const closeFolderDeleteConfirm = useShellUiStore((state) => state.closeFolderDeleteConfirm);
  const setStatusMessage = useShellUiStore((state) => state.setStatusMessage);
  const folder = useLibraryStore((state) =>
    state.folders.find((item) => item.id === folderDeleteId) ?? null,
  );
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  const handleClose = () => {
    closeFolderDeleteConfirm();
    if (returnFocusTarget?.isConnected) {
      window.requestAnimationFrame(() => returnFocusTarget.focus());
    }
  };

  useEffect(() => {
    if (folderDeleteId && !folder) closeFolderDeleteConfirm();
  }, [closeFolderDeleteConfirm, folder, folderDeleteId]);

  useEffect(() => {
    if (!folderDeleteId) return;
    setDeleting(false);
    setErrorMessage(null);
    const frame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [folderDeleteId]);

  if (!folderDeleteId || !folder) return null;

  const handleDelete = async () => {
    setDeleting(true);
    setErrorMessage(null);
    try {
      await commands.execute(COMMAND_IDS.libraryDeleteFolder, folder.id);
      handleClose();
    } catch (error: unknown) {
      const message = error instanceof Error && error.message
        ? error.message
        : '删除失败,请刷新书库后重试';
      setErrorMessage(message);
      setStatusMessage(`删除文件夹失败:${message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-delete-dialog-title"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="folder-delete-dialog-title" className="flex items-center gap-2 text-sm font-semibold text-red-300">
            <AlertTriangle size={16} aria-hidden />
            删除书库文件夹
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="关闭"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="mb-2 text-sm leading-6 text-zinc-300">
          确定要删除“<span className="font-medium text-zinc-100">{folder.name}</span>”及其全部子文件夹吗？
        </p>
        <p className="mb-4 text-sm leading-6 text-zinc-400">
          子文件夹结构将无法恢复，其中的书籍会转为未归类；书籍正文、元数据、批注、阅读位置和打开的阅读视图不会被删除。
        </p>
        {errorMessage ? <p className="mb-4 text-sm leading-6 text-red-300" role="alert">{errorMessage}</p> : null}

        <div className="flex justify-end gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={handleClose}
            disabled={deleting}
            className="min-h-11 rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
            className="min-h-11 rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300"
          >
            {deleting ? '删除中…' : '删除文件夹'}
          </button>
        </div>
      </div>
    </div>
  );
}
