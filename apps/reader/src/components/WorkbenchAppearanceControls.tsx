import { Check, Sparkles } from 'lucide-react';
import type { RefObject } from 'react';

import { WORKBENCH_THEMES, type WorkbenchThemeId } from '../app/workbenchAppearance';

export function WorkbenchThemeOptionList({
  theme,
  onSelect,
  selectedOptionRef,
}: {
  theme: WorkbenchThemeId;
  onSelect: (theme: WorkbenchThemeId) => void;
  selectedOptionRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="app-theme-option-list theme-option-list">
      {WORKBENCH_THEMES.map((option) => {
        const selected = option.id === theme;
        return (
          <button
            key={option.id}
            ref={selected ? selectedOptionRef : undefined}
            className={selected ? 'app-theme-option theme-option selected' : 'app-theme-option theme-option'}
            type="button"
            data-theme-option={option.id}
            aria-pressed={selected}
            onClick={() => onSelect(option.id)}
          >
            <span className="app-theme-option-preview theme-option-preview" aria-hidden>
              <span />
            </span>
            <span className="app-theme-option-copy theme-option-copy">
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </span>
            <span className="app-theme-option-check theme-option-check" aria-hidden>
              {selected ? <Check size={15} /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function WorkbenchGlowToggle({
  glowEnabled,
  onChange,
}: {
  glowEnabled: boolean;
  onChange: () => void;
}) {
  return (
    <button
      className={glowEnabled ? 'app-theme-glow-toggle theme-glow-toggle is-on' : 'app-theme-glow-toggle theme-glow-toggle'}
      type="button"
      role="switch"
      aria-label="背景光效果"
      aria-checked={glowEnabled}
      onClick={onChange}
    >
      <span className="app-theme-glow-icon theme-glow-icon" aria-hidden>
        <Sparkles size={15} />
      </span>
      <span className="app-theme-glow-copy theme-glow-copy">
        <strong>背景光效果</strong>
        <small>
          {glowEnabled ? '已开启 · 每套配色使用对应光晕' : '已关闭 · 使用纯色渐变背景'}
        </small>
      </span>
      <span className="app-theme-glow-state theme-glow-state">{glowEnabled ? '开启' : '关闭'}</span>
    </button>
  );
}
