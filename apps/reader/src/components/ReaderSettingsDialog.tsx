import { RotateCcw, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { FontFamilyKey, ReadingFlow, ReadingTheme, ReadingTypography } from '../domain/reader/typography';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';

const FONT_FAMILY_LABELS: Record<FontFamilyKey, string> = {
  serif: '衬线',
  sansSerif: '无衬线',
  system: '系统默认',
};

const THEME_LABELS: Record<ReadingTheme, string> = {
  light: '浅色',
  sepia: '护眼',
  dark: '深色',
};

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
  const materials = useLibraryStore((state) => state.materials);

  if (!viewId) {
    return null;
  }

  const view = useWorkspaceStore
    .getState()
    .editorGroups.flatMap((group) => group.views)
    .find((v) => v.id === viewId);
  const material = materials.find((m) => m.id === view?.materialId) ?? null;
  if (!view || !material) {
    return null;
  }

  const override = materialTypography[material.id] ?? null;
  const effective: ReadingTypography = override
    ? { ...global, ...override }
    : { ...global };

  const apply = (patch: Partial<ReadingTypography>) => {
    void commands.execute(COMMAND_IDS.readerApplyTypography, viewId, patch).catch(console.error);
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

        {/* 字体 */}
        <label className="mb-1 block text-xs text-zinc-400">字体</label>
        <div className="mb-3 flex gap-2">
          {(Object.keys(FONT_FAMILY_LABELS) as FontFamilyKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => apply({ fontFamily: key })}
              className={`flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                effective.fontFamily === key
                  ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                  : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {FONT_FAMILY_LABELS[key]}
            </button>
          ))}
        </div>

        <SliderRow
          label="字号"
          valueLabel={`${effective.fontSize}px`}
          min={10}
          max={48}
          step={1}
          value={effective.fontSize}
          onChange={(value) => apply({ fontSize: value })}
        />
        <SliderRow
          label="行距"
          valueLabel={effective.lineHeight.toFixed(1)}
          min={1}
          max={3}
          step={0.1}
          value={effective.lineHeight}
          onChange={(value) => apply({ lineHeight: value })}
        />
        <SliderRow
          label="页边距"
          valueLabel={`${effective.margin}px`}
          min={0}
          max={160}
          step={4}
          value={effective.margin}
          onChange={(value) => apply({ margin: value })}
        />

        {/* 主题 */}
        <label className="mb-1 block text-xs text-zinc-400">主题</label>
        <div className="mb-3 flex gap-2">
          {(Object.keys(THEME_LABELS) as ReadingTheme[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => apply({ theme: key })}
              className={`flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                effective.theme === key
                  ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                  : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {THEME_LABELS[key]}
            </button>
          ))}
        </div>

        {/* 分页/滚动 */}
        <label className="mb-1 block text-xs text-zinc-400">阅读模式</label>
        <div className="mb-4 flex gap-2">
          {(['paginated', 'scrolled'] as ReadingFlow[]).map((flow) => (
            <button
              key={flow}
              type="button"
              onClick={() => apply({ flow })}
              className={`flex-1 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                effective.flow === flow
                  ? 'border-sky-500 bg-sky-600/20 text-sky-200'
                  : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {flow === 'paginated' ? '分页' : '滚动'}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-500">
            {override ? '正在使用材料级排版覆盖' : '使用全局默认排版'}
          </p>
          <button
            type="button"
            onClick={handleReset}
            disabled={!override}
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

function SliderRow({
  label,
  valueLabel,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs text-zinc-400">{label}</label>
        <span className="text-xs tabular-nums text-zinc-500">{valueLabel}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-sky-500"
      />
    </div>
  );
}