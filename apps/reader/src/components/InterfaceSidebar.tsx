import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BookOpen, Globe2, Palette, RotateCcw, Settings2 } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { formatFromSourceFileName, formatLabel } from '../domain/library/materialFormat';
import type { PdfFitMode } from '../domain/reader/readingLocation';
import {
  hasTypographyOverride,
  resolveTypography,
  type ReadingFlow,
  type ReadingTypography,
} from '../domain/reader/typography';
import { getWorkbenchTheme } from '../app/workbenchAppearance';
import { useWorkbenchAppearanceStore } from '../workbench/appearanceStore';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { useReaderRuntime } from '../workbench/readerRuntime';
import { SidebarPanelHeader } from './SidebarPanelHeader';
import {
  FONT_FAMILY_LABELS,
  ReadingTypographyControls,
  THEME_LABELS,
} from './ReadingTypographyControls';
import { WorkbenchGlowToggle, WorkbenchThemeOptionList } from './WorkbenchAppearanceControls';

type TypographyScope = 'books' | 'global';

export function InterfaceSidebar() {
  const { commands } = useAppServices();
  const panelRef = useRef<HTMLElement | null>(null);
  const interfacePanelFocusRequestToken = useShellUiStore(
    (state) => state.interfacePanelFocusRequestToken,
  );
  const interfacePanelFocusScope = useShellUiStore((state) => state.interfacePanelFocusScope);
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
  const hasMaterialOverride = hasTypographyOverride(activeMaterialOverride);
  const effectiveTypography = activeMaterial
    ? resolveTypography(globalTypography, activeMaterialOverride)
    : null;
  const activeFormat = activeMaterial
    ? formatFromSourceFileName(activeMaterial.sourceFileName)
    : 'unknown';
  const isPdf = activeFormat === 'pdf';
  const activeDocument = useReaderRuntime((state) =>
    activeView ? state.documents.get(activeView.id) ?? null : null,
  );
  const isReflowableEpub =
    activeFormat === 'epub' && activeDocument?.isReflowable?.() !== false;
  const isFixedLayoutEpub = activeFormat === 'epub' && !isReflowableEpub;
  const hasApplicableMaterialOverride =
    hasMaterialOverride &&
    (!isReflowableEpub ||
      Object.keys(activeMaterialOverride ?? {}).some((key) => key !== 'theme'));
  const pdfLocation = activeView?.location?.kind === 'pdf' ? activeView.location : null;
  const pdfZoom = normalizePdfZoom(pdfLocation?.zoom ?? 100);
  const pdfFit = pdfLocation?.fit ?? 'width';
  const [typographyScope, setTypographyScope] = useState<TypographyScope>(() =>
    activeMaterial ? 'books' : 'global',
  );
  const previousActiveMaterialIdRef = useRef<string | null>(activeMaterial?.id ?? null);
  const lastHandledFocusRequestTokenRef = useRef(interfacePanelFocusRequestToken);
  const booksTabRef = useRef<HTMLButtonElement>(null);
  const globalTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    if (
      interfacePanelFocusRequestToken === lastHandledFocusRequestTokenRef.current ||
      interfacePanelFocusRequestToken <= 0
    ) {
      return;
    }
    lastHandledFocusRequestTokenRef.current = interfacePanelFocusRequestToken;
    if (interfacePanelFocusScope) setTypographyScope(interfacePanelFocusScope);
    panelRef.current?.focus();
  }, [interfacePanelFocusRequestToken, interfacePanelFocusScope]);

  useEffect(() => {
    const previousActiveMaterialId = previousActiveMaterialIdRef.current;
    previousActiveMaterialIdRef.current = activeMaterial?.id ?? null;
    if (!activeMaterial) {
      setTypographyScope('global');
    } else if (previousActiveMaterialId === null) {
      setTypographyScope('books');
    }
  }, [activeMaterial]);

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

  const applyGlobalTypography = (patch: Partial<ReadingTypography>) => {
    void commands
      .execute(COMMAND_IDS.readerSetGlobalTypography, patch)
      .catch(reportTypographyError);
  };

  const resetGlobalTypography = () => {
    void commands
      .execute(COMMAND_IDS.readerResetGlobalTypography)
      .catch(reportTypographyError);
  };

  // 材料在面板保持打开期间消失时立即回退到全局范围;从无材料进入
  // 活动材料时切到书籍范围,在材料之间切换则保留用户已经选择的作用域。
  const isGlobalScope = !activeMaterial || typographyScope === 'global';

  const selectTypographyScope = (nextScope: TypographyScope) => {
    setTypographyScope(nextScope);
    (nextScope === 'books' ? booksTabRef : globalTabRef).current?.focus();
  };

  const handleScopeTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    scope: TypographyScope,
  ) => {
    let nextScope: TypographyScope | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextScope = scope === 'books' ? 'global' : activeMaterial ? 'books' : null;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextScope = scope === 'global' ? (activeMaterial ? 'books' : null) : 'global';
        break;
      case 'Home':
        nextScope = activeMaterial ? 'books' : 'global';
        break;
      case 'End':
        nextScope = 'global';
        break;
      default:
        return;
    }
    if (!nextScope) return;
    event.preventDefault();
    selectTypographyScope(nextScope);
  };

  return (
    <aside
      ref={panelRef}
      aria-label="界面侧栏"
      tabIndex={-1}
      className="app-sidebar-panel app-interface-panel"
    >
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
            改变工作台外壳；可重排 EPUB 正文跟随当前主题，PDF 与固定版式保持原貌。
          </p>
          <WorkbenchThemeOptionList theme={theme} onSelect={setTheme} />
          <WorkbenchGlowToggle glowEnabled={glowEnabled} onChange={setGlowEnabled} />
        </section>

        <div
          className="app-interface-scope-tabs"
          role="tablist"
          aria-label="阅读排版作用范围"
        >
          <button
            id="interface-books-tab"
            type="button"
            role="tab"
            aria-selected={Boolean(activeMaterial) && typographyScope === 'books'}
            aria-controls="interface-books-panel"
            disabled={!activeMaterial}
            ref={booksTabRef}
            onClick={() => selectTypographyScope('books')}
            onKeyDown={(event) => handleScopeTabKeyDown(event, 'books')}
          >
            书籍
          </button>
          <button
            id="interface-global-tab"
            type="button"
            role="tab"
            aria-selected={isGlobalScope}
            aria-controls="interface-global-panel"
            ref={globalTabRef}
            onClick={() => selectTypographyScope('global')}
            onKeyDown={(event) => handleScopeTabKeyDown(event, 'global')}
          >
            全局
          </button>
        </div>

        <section
          id="interface-books-panel"
          role="tabpanel"
          aria-labelledby="interface-books-tab"
          aria-disabled={!activeMaterial}
          className={activeMaterial ? 'app-interface-books' : 'app-interface-books is-disabled'}
          data-scope="books"
          hidden={isGlobalScope}
        >
          <TypographyScopeHeader
            headingId="interface-books-title"
            title="书籍"
            format={activeMaterial ? formatLabel(activeFormat) : '未打开'}
            icon={BookOpen}
          />

          {activeMaterial && activeView && effectiveTypography ? (
            <>
              <div className="app-interface-books-material">
                <strong title={activeMaterial.title}>{activeMaterial.title}</strong>
                <span className={hasApplicableMaterialOverride ? 'is-overridden' : undefined}>
                  {hasApplicableMaterialOverride ? '材料级覆盖' : '跟随全局默认'}
                </span>
              </div>
              <div className="app-interface-books-summary" aria-label="当前生效排版">
                {(isReflowableEpub
                  ? [
                      ['字体', FONT_FAMILY_LABELS[effectiveTypography.fontFamily]],
                      ['字号', `${effectiveTypography.fontSize}px`],
                      ['行距', effectiveTypography.lineHeight.toFixed(1)],
                      ['页边距', `${effectiveTypography.margin}px`],
                      ['主题', currentTheme.label],
                      ['模式', effectiveTypography.flow === 'paginated' ? '分页' : '滚动'],
                    ]
                  : isFixedLayoutEpub
                    ? [
                        ['主题', '原书版式'],
                        ['模式', effectiveTypography.flow === 'paginated' ? '分页' : '滚动'],
                      ]
                    : isPdf
                  ? [
                      ['主题', THEME_LABELS[effectiveTypography.theme]],
                      ['模式', effectiveTypography.flow === 'paginated' ? '分页' : '滚动'],
                    ]
                  : [
                      ['字体', FONT_FAMILY_LABELS[effectiveTypography.fontFamily]],
                      ['字号', `${effectiveTypography.fontSize}px`],
                      ['行距', effectiveTypography.lineHeight.toFixed(1)],
                      ['页边距', `${effectiveTypography.margin}px`],
                      ['主题', THEME_LABELS[effectiveTypography.theme]],
                      ['模式', effectiveTypography.flow === 'paginated' ? '分页' : '滚动'],
                    ]
                ).map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <ReadingTypographyControls
                idPrefix="interface-books"
                effective={effectiveTypography}
                onApply={applyTypography}
                onFlowChange={applyFlow}
                showTheme={!isReflowableEpub && !isFixedLayoutEpub}
                {...(isPdf
                  ? {
                      pdf: {
                        zoom: pdfZoom,
                        fit: pdfFit,
                        onZoomChange: applyPdfZoom,
                        onFitChange: applyPdfFit,
                      },
                    }
                  : {})}
              />
              <TypographyResetFooter
                description="恢复后重新跟随全局默认"
                buttonLabel="恢复默认阅读排版"
                disabled={!hasMaterialOverride}
                onReset={resetTypography}
              />
            </>
          ) : (
            <div className="app-interface-books-empty" role="note">
              <strong>暂无活动阅读材料</strong>
              <span>请先打开一份 EPUB、PDF 或 Markdown 阅读材料，再调整书籍级排版。</span>
            </div>
          )}
        </section>

        <section
          id="interface-global-panel"
          role="tabpanel"
          aria-labelledby="interface-global-tab"
          className="app-interface-global"
          data-scope="global"
          hidden={!isGlobalScope}
        >
          <TypographyScopeHeader
            headingId="interface-global-title"
            title="全局"
            format="整个书库"
            icon={Globe2}
          />
          <p className="app-interface-global-description">整个书库的默认阅读排版。</p>
          <p className="app-interface-global-note" role="note">
            {isReflowableEpub
              ? '当前可重排 EPUB 的正文主题跟随上方工作台主题；全局旧主题仅供其它适用格式使用。'
              : hasMaterialOverride
              ? '当前材料存在材料级覆盖,不会跟随全局默认。'
              : activeMaterial
                ? '当前材料会跟随全局默认。'
                : '全局默认将用于没有材料级覆盖的阅读材料。'}
          </p>
          <ReadingTypographyControls
            idPrefix="interface-global"
            effective={globalTypography}
            onApply={applyGlobalTypography}
            onFlowChange={(flow) => applyGlobalTypography({ flow })}
            showTheme={!isReflowableEpub}
          />
          <TypographyResetFooter
            description="只改变全局默认,不会清除材料级覆盖。"
            buttonLabel="恢复全局默认阅读排版"
            onReset={resetGlobalTypography}
          />
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

function TypographyScopeHeader({
  headingId,
  title,
  format,
  icon: Icon,
}: {
  headingId: string;
  title: string;
  format: string;
  icon: typeof BookOpen;
}) {
  return (
    <div className="app-interface-typography-scope-heading">
      <span className="app-interface-typography-scope-icon" aria-hidden>
        <Icon size={16} />
      </span>
      <div>
        <p className="app-interface-panel-eyebrow">阅读排版</p>
        <h3 id={headingId}>{title}</h3>
      </div>
      <span className="app-interface-typography-scope-format">{format}</span>
    </div>
  );
}

function TypographyResetFooter({
  description,
  buttonLabel,
  disabled = false,
  onReset,
}: {
  description: string;
  buttonLabel: string;
  disabled?: boolean;
  onReset: () => void;
}) {
  return (
    <div className="app-interface-typography-footer">
      <span>{description}</span>
      <button
        type="button"
        className="app-interface-typography-reset"
        disabled={disabled}
        onClick={onReset}
      >
        <RotateCcw size={14} aria-hidden />
        {buttonLabel}
      </button>
    </div>
  );
}
