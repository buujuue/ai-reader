import { BookOpen, Palette, RotateCcw, Settings2 } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { formatFromSourceFileName, formatLabel } from '../domain/library/materialFormat';
import type { PdfFitMode } from '../domain/reader/readingLocation';
import {
  resolveTypography,
  type ReadingFlow,
  type ReadingTypography,
} from '../domain/reader/typography';
import { getWorkbenchTheme } from '../app/workbenchAppearance';
import { useWorkbenchAppearanceStore } from '../workbench/appearanceStore';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { SidebarPanelHeader } from './SidebarPanelHeader';
import {
  FONT_FAMILY_LABELS,
  ReadingTypographyControls,
  THEME_LABELS,
} from './ReadingTypographyControls';
import { WorkbenchGlowToggle, WorkbenchThemeOptionList } from './WorkbenchAppearanceControls';

export function InterfaceSidebar() {
  const { commands } = useAppServices();
  const theme = useWorkbenchAppearanceStore((state) => state.theme);
  const glowEnabled = useWorkbenchAppearanceStore((state) => state.glowEnabled);
  const currentTheme = getWorkbenchTheme(theme);
  const activeView = useWorkspaceStore((state) => {
    const activeGroup = state.editorGroups.find(
      (group) => group.id === state.activeEditorGroupId,
    );
    return activeGroup?.views.find((view) => view.id === activeGroup.activeViewId) ?? null;
  });
  const globalTypography = useWorkspaceStore((state) => state.globalReadingTypography);
  const materialTypography = useWorkspaceStore((state) => state.materialTypography);
  const activeMaterial = useLibraryStore((state) =>
    state.materials.find((material) => material.id === activeView?.materialId) ?? null,
  );
  const activeMaterialOverride = activeMaterial
    ? materialTypography[activeMaterial.id] ?? null
    : null;
  const hasMaterialOverride =
    activeMaterialOverride !== null && Object.keys(activeMaterialOverride).length > 0;
  const effectiveTypography = activeMaterial
    ? resolveTypography(globalTypography, activeMaterialOverride)
    : null;
  const activeFormat = activeMaterial
    ? formatFromSourceFileName(activeMaterial.sourceFileName)
    : 'unknown';
  const isPdf = activeFormat === 'pdf';
  const pdfLocation = activeView?.location?.kind === 'pdf' ? activeView.location : null;
  const pdfZoom = normalizePdfZoom(pdfLocation?.zoom ?? 100);
  const pdfFit = pdfLocation?.fit ?? 'width';

  const setTheme = (nextTheme: typeof theme) => {
    void commands.execute(COMMAND_IDS.workbenchSetAppearanceTheme, nextTheme).catch(() => undefined);
  };

  const setGlowEnabled = () => {
    void commands
      .execute(COMMAND_IDS.workbenchSetBackgroundGlow, !glowEnabled)
      .catch(() => undefined);
  };

  const reportTypographyError = () => {
    useShellUiStore.getState().setStatusMessage('保存阅读排版失败');
  };

  const applyTypography = (patch: Partial<ReadingTypography>) => {
    if (!activeView || !activeMaterial) return;
    void commands
      .execute(COMMAND_IDS.readerApplyTypography, activeView.id, patch)
      .catch(reportTypographyError);
  };

  const applyFlow = (flow: ReadingFlow) => {
    if (!activeView || !activeMaterial) return;
    const commandId = isPdf ? COMMAND_IDS.readerSetPdfFlow : COMMAND_IDS.readerApplyTypography;
    const args = isPdf ? [activeView.id, flow] : [activeView.id, { flow }];
    void commands.execute(commandId, ...args).catch(reportTypographyError);
  };

  const applyPdfZoom = (zoom: number) => {
    if (!activeView || !activeMaterial || !isPdf) return;
    void commands
      .execute(COMMAND_IDS.readerSetPdfViewport, activeView.id, zoom, pdfFit)
      .catch(reportTypographyError);
  };

  const applyPdfFit = (fit: PdfFitMode) => {
    if (!activeView || !activeMaterial || !isPdf) return;
    void commands
      .execute(COMMAND_IDS.readerSetPdfViewport, activeView.id, pdfZoom, fit)
      .catch(reportTypographyError);
  };

  const resetTypography = () => {
    if (!activeView || !activeMaterial) return;
    void commands
      .execute(COMMAND_IDS.readerResetTypography, activeView.id)
      .catch(reportTypographyError);
  };

  return (
    <aside aria-label="界面侧栏" className="app-sidebar-panel app-interface-panel">
      <SidebarPanelHeader icon={Settings2} title="界面" />
      <div className="app-interface-panel-content">
        <section aria-labelledby="interface-appearance-title" className="app-interface-appearance">
          <div className="app-interface-appearance-heading">
            <span className="app-interface-appearance-icon" aria-hidden>
              <Palette size={16} />
            </span>
            <div>
              <p className="app-interface-panel-eyebrow">工作台外观</p>
              <h3 id="interface-appearance-title">主题配色</h3>
            </div>
            <span className="app-interface-appearance-current">{currentTheme.label}</span>
          </div>
          <p className="app-interface-appearance-description">
            只改变工作台外壳，不会改变阅读材料的正文主题。
          </p>
          <WorkbenchThemeOptionList theme={theme} onSelect={setTheme} />
          <WorkbenchGlowToggle glowEnabled={glowEnabled} onChange={setGlowEnabled} />
        </section>
        <section
          aria-labelledby="interface-books-title"
          aria-disabled={!activeMaterial}
          className={activeMaterial ? 'app-interface-books' : 'app-interface-books is-disabled'}
          data-scope="books"
        >
          <div className="app-interface-books-heading">
            <span className="app-interface-books-icon" aria-hidden>
              <BookOpen size={16} />
            </span>
            <div>
              <p className="app-interface-panel-eyebrow">阅读排版</p>
              <h3 id="interface-books-title">书籍</h3>
            </div>
            <span className="app-interface-books-format">
              {activeMaterial ? formatLabel(activeFormat) : '未打开'}
            </span>
          </div>

          {activeMaterial && activeView && effectiveTypography ? (
            <>
              <div className="app-interface-books-material">
                <strong title={activeMaterial.title}>{activeMaterial.title}</strong>
                <span className={hasMaterialOverride ? 'is-overridden' : undefined}>
                  {hasMaterialOverride ? '材料级覆盖' : '跟随全局默认'}
                </span>
              </div>
              <div className="app-interface-books-summary" aria-label="当前生效排版">
                <div>
                  <span>字体</span>
                  <strong>{FONT_FAMILY_LABELS[effectiveTypography.fontFamily]}</strong>
                </div>
                <div>
                  <span>字号</span>
                  <strong>{effectiveTypography.fontSize}px</strong>
                </div>
                <div>
                  <span>行距</span>
                  <strong>{effectiveTypography.lineHeight.toFixed(1)}</strong>
                </div>
                <div>
                  <span>页边距</span>
                  <strong>{effectiveTypography.margin}px</strong>
                </div>
                <div>
                  <span>主题</span>
                  <strong>{THEME_LABELS[effectiveTypography.theme]}</strong>
                </div>
                <div>
                  <span>模式</span>
                  <strong>{effectiveTypography.flow === 'paginated' ? '分页' : '滚动'}</strong>
                </div>
              </div>
              <ReadingTypographyControls
                idPrefix="interface-books"
                effective={effectiveTypography}
                isPdf={isPdf}
                pdfZoom={pdfZoom}
                pdfFit={pdfFit}
                onApply={applyTypography}
                onFlowChange={applyFlow}
                onPdfZoomChange={applyPdfZoom}
                onPdfFitChange={applyPdfFit}
              />
              <div className="app-interface-books-footer">
                <span>恢复后重新跟随全局默认</span>
                <button
                  type="button"
                  className="app-interface-books-reset"
                  disabled={!hasMaterialOverride}
                  onClick={resetTypography}
                >
                  <RotateCcw size={14} aria-hidden />
                  恢复默认阅读排版
                </button>
              </div>
            </>
          ) : (
            <div className="app-interface-books-empty" role="note">
              <strong>暂无活动阅读材料</strong>
              <span>请先打开一份 EPUB、PDF 或 Markdown 阅读材料，再调整书籍级排版。</span>
            </div>
          )}
        </section>
        <p className="app-interface-panel-note" role="note">
          外观偏好保存在本机，刷新或重启后会自动恢复；完整书库备份不会覆盖它。
        </p>
      </div>
    </aside>
  );
}

function normalizePdfZoom(value: number): number {
  return Number.isFinite(value) ? Math.min(400, Math.max(25, Math.round(value))) : 100;
}
