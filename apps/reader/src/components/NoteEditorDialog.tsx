import { useEffect, useState } from 'react';
import { StickyNote, Trash2, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useAnnotationStore } from '../workbench/annotationStore';
import { useShellUiStore } from '../workbench/shellUiStore';

/**
 * 笔记编辑器:为已有高亮添加或编辑文字笔记,并可删除该批注。
 * 变更经稳定 Command 执行;笔记只在平台保存成功后更新界面。
 */
export function NoteEditorDialog() {
  const { commands } = useAppServices();
  const target = useShellUiStore((state) => state.noteEditorTarget);
  const closeNoteEditor = useShellUiStore((state) => state.closeNoteEditor);
  const annotation = useAnnotationStore((state) =>
    target
      ? state.byMaterial[target.materialId]?.find((item) => item.id === target.annotationId) ?? null
      : null,
  );

  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setNote(annotation?.note ?? '');
  }, [annotation]);

  if (!target) {
    return null;
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      await commands.execute(
        COMMAND_IDS.annotationUpdateNote,
        target.materialId,
        target.annotationId,
        note,
      );
      closeNoteEditor();
    } catch (error) {
      console.error('保存笔记失败', error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    await commands
      .execute(COMMAND_IDS.annotationDelete, target.materialId, target.annotationId)
      .catch((error: unknown) => console.error('删除批注失败', error));
    closeNoteEditor();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="编辑批注笔记"
      onClick={closeNoteEditor}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <StickyNote size={16} aria-hidden />
            文字笔记
          </h2>
          <button
            type="button"
            onClick={closeNoteEditor}
            aria-label="关闭"
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {annotation ? (
          <blockquote className="mb-3 rounded-md border-l-2 border-amber-400 bg-zinc-950 px-3 py-2 text-sm text-zinc-300">
            {annotation.anchor.quote}
          </blockquote>
        ) : null}

        <label className="mb-1 block text-xs text-zinc-400">笔记</label>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={5}
          className="mb-4 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
          placeholder="记录你的想法…"
          autoFocus
        />

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleDelete}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-950/40 hover:text-red-300"
          >
            <Trash2 size={14} aria-hidden />
            删除
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={closeNoteEditor}
              className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}