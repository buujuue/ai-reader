import { Download, FileWarning, Search, StickyNote, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { Annotation } from '../domain/annotation/annotation';
import { decodePdfTextAnchor, isPdfTextAnchor } from '../domain/reader/pdf/pdfTextAnchor';
import { useAnnotationStore } from '../workbench/annotationStore';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';

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
    annotation.note.trim() ? '带文字笔记' : '仅高亮',
  ]
    .join('\n')
    .toLocaleLowerCase();
  return searchable.includes(query.trim().toLocaleLowerCase());
}

export interface AnnotationPanelProps {
  materialId: string;
  onClose: () => void;
}

/** 材料级批注覆盖面板;归属由打开它的 Material More Menu 显式传入。 */
export function AnnotationPanel({ materialId, onClose }: AnnotationPanelProps) {
  const { commands } = useAppServices();
  const panelRef = useRef<HTMLElement | null>(null);
  const returnFocusTarget = useShellUiStore((state) => state.annotationPanelReturnFocus);
  const materials = useLibraryStore((state) => state.materials);
  const annotations = useAnnotationStore(
    (state) => state.byMaterial[materialId] ?? EMPTY_ANNOTATIONS,
  );
  const [query, setQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const material = materials.find((candidate) => candidate.id === materialId);
  const filtered = useMemo(
    () => annotations.filter((annotation) => matchesQuery(annotation, query)),
    [annotations, query],
  );

  useEffect(() => {
    panelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (returnFocusTarget?.isConnected !== false) returnFocusTarget?.focus();
    };
  }, [onClose, returnFocusTarget]);

  const handleJump = (annotation: Annotation) => {
    void commands
      .execute(COMMAND_IDS.annotationGoTo, materialId, annotation.id)
      .catch(() => undefined);
  };

  const handleEdit = (annotation: Annotation) => {
    void commands
      .execute(COMMAND_IDS.annotationOpenNoteEditor, annotation.materialId, annotation.id)
      .catch(() => undefined);
  };

  const handleExport = () => {
    if (!material || exporting) return;
    setExporting(true);
    void commands
      .execute(COMMAND_IDS.annotationExportMarkdown, materialId)
      .catch(() => undefined)
      .finally(() => setExporting(false));
  };

  return (
    <div className="app-annotation-overlay" role="presentation">
      <button
        type="button"
        className="app-annotation-backdrop"
        aria-label="关闭材料批注面板背景"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="材料批注面板"
        tabIndex={-1}
        className="app-annotation-panel"
      >
        <header className="app-annotation-header">
          <div className="flex min-w-0 items-center gap-2">
            <StickyNote size={17} aria-hidden />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">材料批注</h2>
              <p className="truncate text-[11px] text-[var(--prototype-text-muted)]">
                {material?.title ?? '未知材料'}
              </p>
            </div>
            <span className="rounded-full bg-[var(--prototype-surface-soft)] px-1.5 py-0.5 text-[10px]">
              {annotations.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleExport}
              disabled={!material || exporting}
              aria-label="导出材料批注"
              title="导出材料批注为 Markdown"
              className="app-icon-button"
            >
              <Download size={15} aria-hidden />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭材料批注面板"
              title="关闭材料批注面板"
              className="app-icon-button"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </header>

        <div className="app-annotation-filter">
          <Search size={13} aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按引文、笔记或状态筛选…"
            aria-label="筛选批注"
          />
        </div>

        <div className="app-annotation-summary" aria-live="polite">
          <span>全部 {annotations.length}</span>
          <span>仅高亮 {annotations.filter((annotation) => !annotation.note.trim()).length}</span>
          <span>带笔记 {annotations.filter((annotation) => annotation.note.trim()).length}</span>
        </div>

        {filtered.length === 0 ? (
          <div className="app-annotation-empty">
            {annotations.length === 0 ? '这份材料还没有批注' : '没有匹配的批注'}
          </div>
        ) : (
          <ul className="app-annotation-list">
            {filtered.map((annotation) => {
              const orphaned = annotation.anchor.recoveryState === 'orphaned';
              const label = annotationLabel(annotation);
              const kindLabel = annotation.note.trim() ? '带文字笔记' : '仅高亮';
              return (
                <li key={annotation.id} className={orphaned ? 'app-annotation-card orphaned' : 'app-annotation-card'}>
                  <div className="app-annotation-card-meta">
                    <span>{kindLabel}</span>
                    {orphaned ? (
                      <span className="app-annotation-orphaned">
                        <FileWarning size={12} aria-hidden />
                        失联批注
                      </span>
                    ) : null}
                  </div>
                  <div className="app-annotation-card-row">
                    <button
                      type="button"
                      onClick={() => handleJump(annotation)}
                      aria-label={`跳转到批注 ${label}`}
                      disabled={orphaned}
                      title={orphaned ? '失联批注无法安全跳转' : '跳转到正文位置'}
                      className="app-annotation-jump"
                    >
                      <span>{label}</span>
                      {annotation.note ? <small>{annotation.note}</small> : null}
                    </button>
                    <button
                      type="button"
                      aria-label={`编辑批注 ${annotation.id}`}
                      onClick={() => handleEdit(annotation)}
                      className="app-annotation-edit"
                    >
                      编辑
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );
}

/** 兼容旧测试/外部导入名;生产 App 只挂载 AnnotationPanel。 */
export const AnnotationSidebar = AnnotationPanel;
