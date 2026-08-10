import { Download, FileWarning, Search, StickyNote } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { Annotation } from '../domain/annotation/annotation';
import { isPdfTextAnchor, decodePdfTextAnchor } from '../domain/reader/pdf/pdfTextAnchor';
import { useAnnotationStore } from '../workbench/annotationStore';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';

const EMPTY_ANNOTATIONS: Annotation[] = [];

function annotationLabel(annotation: Annotation): string {
  if (annotation.anchor.quote.trim()) return annotation.anchor.quote;
  if (isPdfTextAnchor(annotation.anchor.cfi)) {
    const location = decodePdfTextAnchor(annotation.anchor.cfi);
    return location ? `PDF 第 ${location.page} 页区域批注` : 'PDF 区域批注';
  }
  return '无文本批注';
}

function matchesQuery(annotation: Annotation, query: string): boolean {
  if (!query.trim()) return true;
  const searchable = [
    annotation.anchor.quote,
    annotation.note,
    annotation.anchor.before,
    annotation.anchor.after,
    annotationLabel(annotation),
    annotation.anchor.recoveryState === 'orphaned' ? '失联' : '高亮',
  ]
    .join('\n')
    .toLocaleLowerCase();
  return searchable.includes(query.trim().toLocaleLowerCase());
}

/**
 * 主要阅读材料的材料级批注面板。它不跟随当前焦点切换，只读取 Workspace Store
 * 中显式指定的 primaryMaterialId；点击条目统一交给 Command 负责打开/聚焦正文并跳转。
 */
export function AnnotationSidebar() {
  const { commands } = useAppServices();
  const primaryMaterialId = useWorkspaceStore((state) => state.primaryMaterialId);
  const materials = useLibraryStore((state) => state.materials);
  const annotations = useAnnotationStore((state) =>
    primaryMaterialId ? state.byMaterial[primaryMaterialId] ?? EMPTY_ANNOTATIONS : EMPTY_ANNOTATIONS,
  );
  const [query, setQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const material = materials.find((candidate) => candidate.id === primaryMaterialId);
  const filtered = useMemo(
    () => annotations.filter((annotation) => matchesQuery(annotation, query)),
    [annotations, query],
  );

  const handleJump = (annotation: Annotation) => {
    if (!primaryMaterialId) return;
    void commands
      .execute(COMMAND_IDS.annotationGoTo, primaryMaterialId, annotation.id)
      .catch(() => undefined);
  };

  const handleEdit = (annotation: Annotation) => {
    useShellUiStore.getState().openNoteEditor(annotation.materialId, annotation.id);
  };

  const handleExport = () => {
    if (!primaryMaterialId || !material || exporting) return;
    setExporting(true);
    void commands
      .execute(COMMAND_IDS.annotationExportMarkdown, primaryMaterialId)
      .catch(() => undefined)
      .finally(() => setExporting(false));
  };

  return (
    <aside
      aria-label="批注侧栏"
      className="flex w-72 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/40"
    >
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2.5">
        <StickyNote size={16} aria-hidden className="text-zinc-400" />
        <h2 className="truncate text-sm font-semibold text-zinc-200">主要材料批注</h2>
        {primaryMaterialId ? (
          <span className="ml-auto rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {annotations.length}
          </span>
        ) : null}
        <button
          type="button"
          onClick={handleExport}
          disabled={!material || exporting}
          aria-label="导出主要材料批注"
          title="导出主要材料批注为人类可读 Markdown"
          className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download size={14} aria-hidden />
        </button>
      </div>

      {material ? (
        <div className="border-b border-zinc-800 px-3 py-2">
          <p className="truncate text-xs font-medium text-sky-300">{material.title}</p>
          <p className="truncate text-[10px] text-zinc-500">主要阅读材料</p>
          <p className="mt-1 text-[10px] leading-4 text-zinc-600">
            Markdown 是人类可读的数据出口，不用于完整书库恢复。
          </p>
        </div>
      ) : null}

      {primaryMaterialId ? (
        <div className="border-b border-zinc-800 px-3 py-2">
          <div className="relative">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按批注文本筛选…"
              aria-label="筛选批注"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-7 pr-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>
      ) : null}

      {!primaryMaterialId ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <StickyNote size={24} aria-hidden className="text-zinc-600" />
          <p className="text-sm text-zinc-400">尚未指定主要阅读材料</p>
          <p className="text-xs leading-5 text-zinc-500">可在书库卡片上指定，批注会集中显示在这里。</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs leading-5 text-zinc-500">
          {annotations.length === 0 ? '这份材料还没有批注' : '没有匹配的批注'}
        </div>
      ) : (
        <ul className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
          {filtered.map((annotation) => {
            const orphaned = annotation.anchor.recoveryState === 'orphaned';
            const label = annotationLabel(annotation);
            return (
              <li key={annotation.id} className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => handleJump(annotation)}
                    aria-label={`跳转到批注 ${label}`}
                    className="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                    title={orphaned ? '失联批注无法安全跳转' : '跳转到正文位置'}
                  >
                    <span
                      className={`block text-xs leading-5 ${
                        orphaned ? 'text-zinc-500 line-through' : 'text-zinc-200'
                      }`}
                    >
                      {label}
                    </span>
                    {annotation.note ? (
                      <span className="mt-1 block whitespace-pre-wrap text-[11px] leading-4 text-zinc-400">
                        {annotation.note}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`编辑批注 ${annotation.id}`}
                    onClick={() => handleEdit(annotation)}
                    className="shrink-0 rounded px-1.5 py-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    编辑
                  </button>
                </div>
                {orphaned ? (
                  <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-amber-400">
                    <FileWarning size={11} aria-hidden />
                    失联批注
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
