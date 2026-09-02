import type { ChangeEvent } from 'react';

import type { PdfFitMode } from '../domain/reader/readingLocation';
import type {
  FontFamilyKey,
  ReadingFlow,
  ReadingTheme,
  ReadingTypography,
} from '../domain/reader/typography';

export const FONT_FAMILY_LABELS: Record<FontFamilyKey, string> = {
  serif: '衬线',
  sansSerif: '无衬线',
  system: '系统默认',
};

export const THEME_LABELS: Record<ReadingTheme, string> = {
  light: '浅色',
  sepia: '护眼',
  dark: '深色',
};

export const PDF_FIT_LABELS: Record<PdfFitMode, string> = {
  width: '宽度',
  height: '高度',
  page: '整页',
  actual: '实际大小',
};

interface ReadingTypographyControlsProps {
  /** 由作用域调用方提供稳定前缀,确保书籍级和全局控件的 DOM id 不重复。 */
  idPrefix: string;
  effective: ReadingTypography;
  onApply: (patch: Partial<ReadingTypography>) => void;
  onFlowChange: (flow: ReadingFlow) => void;
  /** 只有材料级 PDF 作用域注入此配置;全局作用域不显示 PDF 视图控件。 */
  pdf?: {
    zoom: number;
    fit: PdfFitMode;
    onZoomChange: (zoom: number) => void;
    onFitChange: (fit: PdfFitMode) => void;
  };
}

/**
 * 阅读排版控件的共享表现层。材料级 Command 和 PDF View 级 Command
 * 由调用方注入，避免控件自己绕过工作台的命令边界。
 */
export function ReadingTypographyControls({
  idPrefix,
  effective,
  onApply,
  onFlowChange,
  pdf,
}: ReadingTypographyControlsProps) {
  return (
    <div className="app-reader-typography-controls">
      <fieldset className="app-reader-setting-group">
        <legend>文字</legend>
        <OptionGroup
          label="字体"
          options={Object.entries(FONT_FAMILY_LABELS) as [FontFamilyKey, string][]}
          selected={effective.fontFamily}
          onSelect={(fontFamily) => onApply({ fontFamily })}
        />
        <TypographySlider
          id={`${idPrefix}-font-size`}
          label="字号"
          valueLabel={`${effective.fontSize}px`}
          min={10}
          max={48}
          step={1}
          value={effective.fontSize}
          onChange={(value) => onApply({ fontSize: value })}
        />
        <TypographySlider
          id={`${idPrefix}-line-height`}
          label="行距"
          valueLabel={effective.lineHeight.toFixed(1)}
          min={1}
          max={3}
          step={0.1}
          value={effective.lineHeight}
          onChange={(value) => onApply({ lineHeight: value })}
        />
        <TypographySlider
          id={`${idPrefix}-margin`}
          label="页边距"
          valueLabel={`${effective.margin}px`}
          min={0}
          max={160}
          step={4}
          value={effective.margin}
          onChange={(value) => onApply({ margin: value })}
        />
      </fieldset>

      <fieldset className="app-reader-setting-group">
        <legend>显示</legend>
        <OptionGroup
          label="主题"
          options={Object.entries(THEME_LABELS) as [ReadingTheme, string][]}
          selected={effective.theme}
          onSelect={(theme) => onApply({ theme })}
        />
        <OptionGroup
          label="阅读模式"
          options={[
            ['paginated', '分页'],
            ['scrolled', '滚动'],
          ]}
          selected={effective.flow}
          onSelect={onFlowChange}
        />
      </fieldset>

      {pdf ? (
        <fieldset className="app-reader-setting-group">
          <legend>PDF 视图</legend>
          <OptionGroup
            label="页面适配"
            options={Object.entries(PDF_FIT_LABELS) as [PdfFitMode, string][]}
            selected={pdf.fit}
            onSelect={pdf.onFitChange}
          />
          <TypographySlider
            id={`${idPrefix}-pdf-zoom`}
            label="缩放"
            valueLabel={`${pdf.zoom}%`}
            min={25}
            max={400}
            step={1}
            value={pdf.zoom}
            onChange={pdf.onZoomChange}
          />
          <p className="app-reader-setting-help">页面适配和缩放仅作用于当前阅读视图。</p>
        </fieldset>
      ) : null}
    </div>
  );
}

function OptionGroup<T extends string>({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: [T, string][];
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="app-reader-setting-control">
      <span className="app-reader-setting-label">{label}</span>
      <div className="app-reader-setting-options" role="group" aria-label={label}>
        {options.map(([value, optionLabel]) => (
          <button
            key={value}
            type="button"
            className="app-reader-setting-option"
            aria-pressed={selected === value}
            onClick={() => onSelect(value)}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

function TypographySlider({
  id,
  label,
  valueLabel,
  min,
  max,
  step,
  value,
  onChange,
}: {
  id: string;
  label: string;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(Number(event.target.value));
  };

  return (
    <div className="app-reader-setting-control app-reader-setting-slider">
      <div className="app-reader-setting-label-row">
        <label htmlFor={id} className="app-reader-setting-label">
          {label}
        </label>
        <output htmlFor={id} className="app-reader-setting-value">
          {valueLabel}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={handleChange}
      />
    </div>
  );
}
