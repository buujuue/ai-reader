import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';

/**
 * 永久删除二次确认对话框:只在用户显式确认后才永久删除回收站材料。
 * 取消或关闭不会改变任何数据。永久删除不可恢复,因此需要输入书名确认。
 */
export function PurgeConfirmDialog() {
  const { commands } = useAppServices();
  const purgeMaterialId = useShellUiStore((state) => state.purgeMaterialId);
  const closePurgeConfirm = useShellUiStore((state) => state.closePurgeConfirm);
  const material = useLibraryStore((state) =>
    state.trashedMaterials.find((item) => item.id === purgeMaterialId) ?? null,
  );
  const [confirmText, setConfirmText] = useState('');
  const [purging, setPurging] = useState(false);

  if (!purgeMaterialId || !material) {
    return null;
  }

  const confirmed = confirmText === material.title;

  const handlePurge = async () => {
    if (!confirmed) return;
    setPurging(true);
    try {
      await commands.execute(COMMAND_IDS.libraryPurge, material.id);
      closePurgeConfirm();
      setConfirmText('');
    } catch (error) {
      console.error('永久删除失败', error);
    } finally {
      setPurging(false);
    }
  };

  const handleCancel = () => {
    closePurgeConfirm();
    setConfirmText('');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="永久删除确认"
      onClick={handleCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-red-300">
            <AlertTriangle size={16} aria-hidden />
            永久删除
          </h2>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="关闭"
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="mb-4 text-sm leading-6 text-zinc-300">
          即将永久删除 <span className="font-medium text-zinc-100">{material.title}</span> 及其托管文件、
          封面和全部阅读数据。此操作不可恢复。请输入书名以确认:
        </p>

        <input
          type="text"
          value={confirmText}
          onChange={(event) => setConfirmText(event.target.value)}
          placeholder={material.title}
          aria-label="输入书名以确认永久删除"
          className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-red-500"
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handlePurge}
            disabled={!confirmed || purging}
            className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
          >
            {purging ? '删除中…' : '永久删除'}
          </button>
        </div>
      </div>
    </div>
  );
}