import { RotateCcw, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { formatFromSourceFileName } from '../domain/library/materialFormat';
import type { PdfFitMode } from '../domain/reader/readingLocation';
import type { ReadingFlow, ReadingTypography } from '../domain/reader/typography';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { ReadingTypographyControls } from './ReadingTypographyControls';

/**
 * 排版设置对话框:调整当前激活阅读视图所属材料的字体、字号、行距、页边距、
 * 主题与分页/滚动模式,并可将材料级覆盖恢复为全局默认。
 *
 * 说明:作用于"阅读材料级排版覆盖"(按 BookId 共享,同一材料的多个
 * ReadingView 呈现一致),不复制成互相漂移的 View 设置。每次调整都经稳定
 * Command 执行并持久化,界面反映的是平台持久化后的权威状态。
 */
export function ReaderSettingsDialog() {
  const { commands } = useAppServices();
  const viewId = useShellUiStore((state) => state.typographyEditorViewId);
  const closeTypographyEditor = useShellUiStore((state) => state.closeTypographyEditor);

  const global = useWorkspaceStore((state) => state.globalReadingTypography);
  const materialTypography = useWorkspaceStore((state) => state.materialTypography);
  const editorGroups = useWorkspaceStore((state) => state.editorGroups);
  const materials = useLibraryStore((state) => state.materials);

  if (!viewId) {
    return null;
  }

  const view = editorGroups.flatMap((group) => group.views).find((v) => v.id === viewId);
  const material = materials.find((m) => m.id === view?.materialId) ?? null;
  if (!view || !material) {
    return null;
  }

  const isPdf = formatFromSourceFileName(material.sourceFileName) === 'pdf';
  const pdfLocation = view.location?.kind === 'pdf' ? view.location : null;
  const pdfZoom = pdfLocation?.zoom ?? 100;
  const pdfFit = pdfLocation?.fit ?? 'width';

  const override = materialTypography[material.id] ?? null;
  const hasMaterialOverride = override !== null && Object.keys(override).length > 0;
  const effective: ReadingTypography = { ...global, ...override };

  const apply = (patch: Partial<ReadingTypography>) => {
    void commands.execute(COMMAND_IDS.readerApplyTypography, viewId, patch).catch(console.error);
  };

  // PDF 流模式走专用 Command(仅作用于 PDF 阅读视图并持久化);其余格式沿用排版。
  const applyFlow = (flow: ReadingFlow) => {
    if (isPdf) {
      void commands.execute(COMMAND_IDS.readerSetPdfFlow, viewId, flow).catch(console.error);
    } else {
      apply({ flow });
    }
  };

  const applyPdfZoom = (zoom: number) => {
    void commands
      .execute(COMMAND_IDS.readerSetPdfViewport, viewId, zoom, pdfFit)
      .catch(console.error);
  };

  const applyPdfFit = (fit: PdfFitMode) => {
    void commands
      .execute(COMMAND_IDS.readerSetPdfViewport, viewId, pdfZoom, fit)
      .catch(console.error);
  };

  const handleReset = () => {
    void commands.execute(COMMAND_IDS.readerResetTypography, viewId).catch(console.error);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`调整 ${material.title} 的阅读排版`}
      onClick={closeTypographyEditor}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="truncate text-sm font-semibold text-zinc-100">阅读排版</h2>
          <button
            type="button"
            onClick={closeTypographyEditor}
            aria-label="关闭"
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="mb-4 line-clamp-1 text-xs text-zinc-500" title={material.title}>
          {material.title}
        </p>

        <ReadingTypographyControls
          idPrefix="dialog-book"
          effective={effective}
          isPdf={isPdf}
          pdfZoom={pdfZoom}
          pdfFit={pdfFit}
          onApply={apply}
          onFlowChange={applyFlow}
          onPdfZoomChange={applyPdfZoom}
          onPdfFitChange={applyPdfFit}
        />

        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-500">
            {hasMaterialOverride ? '正在使用材料级排版覆盖' : '使用全局默认排版'}
          </p>
          <button
            type="button"
            onClick={handleReset}
            disabled={!hasMaterialOverride}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw size={14} aria-hidden />
            恢复为全局默认
          </button>
        </div>
      </div>
    </div>
  );
}
