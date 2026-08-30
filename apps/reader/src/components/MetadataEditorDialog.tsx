import { useEffect, useState } from 'react';
import { BookMarked, ImagePlus, RotateCcw, Trash2, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';

/**
 * 元数据编辑器:覆盖标题、作者与封面,并可一键恢复来源元数据。
 * 所有变更都经稳定 Command 执行,界面只在平台返回权威结果后更新,写入失败不会只改界面。
 */
export function MetadataEditorDialog() {
  const { commands, importRepository } = useAppServices();
  const materialId = useShellUiStore((state) => state.metadataEditorMaterialId);
  const closeMetadataEditor = useShellUiStore((state) => state.closeMetadataEditor);
  const material = useLibraryStore((state) =>
    state.materials.find((item) => item.id === materialId) ?? null,
  );

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!material) return;
    setTitle(material.title);
    setAuthor(material.author ?? '');
  }, [material]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    if (!material) {
      setCoverUrl(null);
      return;
    }
    void importRepository
      .readCover(material.id)
      .then((bytes) => {
        if (cancelled) return;
        if (bytes) {
          const coverBytes = bytes.bytes.slice();
          objectUrl = URL.createObjectURL(
            new Blob([coverBytes.buffer as ArrayBuffer], { type: bytes.mimeType }),
          );
          setCoverUrl(objectUrl);
        } else {
          setCoverUrl(null);
        }
      })
      .catch(() => {
        if (!cancelled) setCoverUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [material, importRepository]);

  if (!materialId || !material) {
    return null;
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      await commands.execute(COMMAND_IDS.libraryUpdateMetadata, material.id, title, author);
      closeMetadataEditor();
    } catch (error) {
      console.error('保存元数据失败', error);
    } finally {
      setSaving(false);
    }
  };

  const handleSetCover = async () => {
    await commands.execute(COMMAND_IDS.librarySetCover, material.id).catch(() => undefined);
  };

  const handleRemoveCover = async () => {
    await commands.execute(COMMAND_IDS.libraryRemoveCover, material.id).catch(() => undefined);
  };

  const handleRestore = async () => {
    await commands.execute(COMMAND_IDS.libraryRestoreMetadata, material.id).catch(() => undefined);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`编辑 ${material.title} 的元数据`}
      onClick={closeMetadataEditor}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">编辑元数据</h2>
          <button
            type="button"
            onClick={closeMetadataEditor}
            aria-label="关闭"
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="mb-4 flex gap-4">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt="自定义封面"
              className="h-28 w-20 shrink-0 rounded-sm border border-zinc-700 object-cover"
            />
          ) : (
            <div className="flex h-28 w-20 shrink-0 items-center justify-center rounded-sm border border-zinc-700 bg-zinc-800 text-zinc-500">
              <BookMarked size={20} aria-hidden />
            </div>
          )}
          <div className="flex flex-col justify-center gap-2">
            <button
              type="button"
              onClick={handleSetCover}
              className="flex items-center gap-2 rounded-md border border-zinc-600 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-800"
            >
              <ImagePlus size={14} aria-hidden />
              更换封面
            </button>
            <button
              type="button"
              onClick={handleRemoveCover}
              className="flex items-center gap-2 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Trash2 size={14} aria-hidden />
              移除封面
            </button>
          </div>
        </div>

        <label htmlFor={`metadata-title-${material.id}`} className="mb-1 block text-xs text-zinc-400">
          标题
        </label>
        <input
          id={`metadata-title-${material.id}`}
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
          placeholder="留空则使用来源标题"
        />

        <label htmlFor={`metadata-author-${material.id}`} className="mb-1 block text-xs text-zinc-400">
          作者
        </label>
        <input
          id={`metadata-author-${material.id}`}
          type="text"
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
          className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
          placeholder="留空则使用来源作者"
        />

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleRestore}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <RotateCcw size={14} aria-hidden />
            恢复来源元数据
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={closeMetadataEditor}
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
