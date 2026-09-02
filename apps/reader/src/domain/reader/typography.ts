/**
 * 阅读排版(Reading Typography):全局阅读默认、阅读材料级排版覆盖与
 * ReadingView 级视口状态是三个不同数据层级。本模块定义排版设置的结构、
 * 默认值、全局默认与材料级覆盖的合并规则,以及把排版转为注入文档的 CSS。
 *
 * 安全边界(ADR-0010):`buildTypographyCss` 只接受本模块定义的、固定的
 * 字体族键与主题,不接收任意字符串,因此注入的 CSS 不会放宽脚本、远程资源
 * 或 Tauri Capability 边界。
 */

/** 分页或滚动阅读模式。 */
export type ReadingFlow = 'paginated' | 'scrolled';

/** 阅读主题:决定页面背景与前景文字颜色。 */
export type ReadingTheme = 'light' | 'sepia' | 'dark';

/**
 * 字体族键。它们只是固定的标识符,真正的 CSS 字体族由
 * `FONT_FAMILY_CSS` 在建 CSS 时映射,避免把用户输入直接拼进 CSS。
 */
export type FontFamilyKey = 'serif' | 'sansSerif' | 'system';

/** 一份完整(或部分)的阅读排版设置。 */
export interface ReadingTypography {
  /** 字体族(固定键)。 */
  fontFamily: FontFamilyKey;
  /** 字号(px)。 */
  fontSize: number;
  /** 行距(无单位倍数)。 */
  lineHeight: number;
  /** 页边距(px)。 */
  margin: number;
  /** 分栏间距(百分比)。 */
  gap: number;
  /** 分页或滚动模式。 */
  flow: ReadingFlow;
  /** 主题。 */
  theme: ReadingTheme;
}

/** 全局阅读排版的默认值。 */
export const DEFAULT_READING_TYPOGRAPHY: ReadingTypography = Object.freeze({
  fontFamily: 'sansSerif',
  fontSize: 18,
  lineHeight: 1.6,
  margin: 48,
  gap: 7,
  flow: 'paginated',
  theme: 'light',
});

/** 字体族键到 CSS 字体族列表的映射(固定,不拼接用户输入)。 */
export const FONT_FAMILY_CSS: Record<FontFamilyKey, string> = {
  serif: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
  sansSerif:
    '"Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
};

/** 主题到背景/前景色的映射。 */
export const THEME_PALETTES: Record<ReadingTheme, { background: string; foreground: string }> = {
  light: { background: '#ffffff', foreground: '#1f2937' },
  sepia: { background: '#f5ecd7', foreground: '#3b2f1d' },
  dark: { background: '#18181b', foreground: '#e4e4e7' },
};

/** 内容文档内滚动条滑块颜色,按阅读主题保持足够的可见度。 */
const READING_SCROLLBAR_THUMB_COLORS: Record<ReadingTheme, string> = {
  light: 'rgb(31 41 55 / 35%)',
  sepia: 'rgb(59 47 29 / 35%)',
  dark: 'rgb(228 228 231 / 35%)',
};

export function isFontFamilyKey(value: unknown): value is FontFamilyKey {
  return value === 'serif' || value === 'sansSerif' || value === 'system';
}

export function isReadingFlow(value: unknown): value is ReadingFlow {
  return value === 'paginated' || value === 'scrolled';
}

export function isReadingTheme(value: unknown): value is ReadingTheme {
  return value === 'light' || value === 'sepia' || value === 'dark';
}

/** 校验一个未知值是否为合法的完整排版设置。 */
export function isReadingTypography(value: unknown): value is ReadingTypography {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ReadingTypography>;
  return (
    isFontFamilyKey(candidate.fontFamily) &&
    typeof candidate.fontSize === 'number' &&
    typeof candidate.lineHeight === 'number' &&
    typeof candidate.margin === 'number' &&
    typeof candidate.gap === 'number' &&
    isReadingFlow(candidate.flow) &&
    isReadingTheme(candidate.theme)
  );
}

/**
 * 校验一个未知值是否为合法的部分排版覆盖(材料级覆盖允许只覆盖部分字段)。
 * 空对象是合法的(表示"无覆盖",由调用方决定是否保留)。
 */
export function isTypographyOverride(value: unknown): value is Partial<ReadingTypography> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ReadingTypography>;
  if (candidate.fontFamily !== undefined && !isFontFamilyKey(candidate.fontFamily)) return false;
  if (candidate.fontSize !== undefined && typeof candidate.fontSize !== 'number') return false;
  if (candidate.lineHeight !== undefined && typeof candidate.lineHeight !== 'number') return false;
  if (candidate.margin !== undefined && typeof candidate.margin !== 'number') return false;
  if (candidate.gap !== undefined && typeof candidate.gap !== 'number') return false;
  if (candidate.flow !== undefined && !isReadingFlow(candidate.flow)) return false;
  if (candidate.theme !== undefined && !isReadingTheme(candidate.theme)) return false;
  return true;
}

/** 判断材料级排版覆盖是否真正覆盖了至少一个字段。 */
export function hasTypographyOverride(
  override: Partial<ReadingTypography> | null | undefined,
): boolean {
  return override !== null && override !== undefined && Object.keys(override).length > 0;
}

/**
 * 合并全局默认与材料级覆盖,得到材料实际生效的排版。
 * 覆盖为 null/undefined 时直接使用全局默认。
 */
export function resolveTypography(
  global: ReadingTypography,
  override: Partial<ReadingTypography> | null | undefined,
): ReadingTypography {
  return override ? { ...global, ...override } : global;
}

/**
 * 把排版设置转为注入到文档的 CSS。
 *
 * 字体与颜色全部来自固定映射,不拼接自由文本;`background-color` 直接铺满
 * 文档,保证主题背景在分页与滚动模式下都覆盖整个视口,不依赖 foliate 对
 * `--theme-bg-color` 的解析(该解析只在书籍自带背景时才生效)。
 */
export function buildTypographyCss(settings: ReadingTypography): string {
  const palette = THEME_PALETTES[settings.theme];
  const fontFamily = FONT_FAMILY_CSS[settings.fontFamily];
  const scrollbarThumb = READING_SCROLLBAR_THUMB_COLORS[settings.theme];
  return `
html {
  --font-family: ${fontFamily};
  --font-size: ${settings.fontSize}px;
  --line-height: ${settings.lineHeight};
  --theme-bg-color: ${palette.background};
  --reading-scrollbar-thumb: ${scrollbarThumb};
  background-color: ${palette.background} !important;
  color: ${palette.foreground} !important;
}
html, body {
  font-family: ${fontFamily};
  font-size: ${settings.fontSize}px !important;
  line-height: ${settings.lineHeight};
  background-color: ${palette.background} !important;
  color: ${palette.foreground} !important;
}
html, body, body * {
  scrollbar-width: thin;
  scrollbar-color: var(--reading-scrollbar-thumb) transparent;
}
html::-webkit-scrollbar,
body::-webkit-scrollbar,
body *::-webkit-scrollbar {
  width: 8px;
  height: 8px;
  background: transparent;
}
html::-webkit-scrollbar-track,
body::-webkit-scrollbar-track,
body *::-webkit-scrollbar-track,
html::-webkit-scrollbar-corner,
body::-webkit-scrollbar-corner,
body *::-webkit-scrollbar-corner {
  background: transparent;
}
html::-webkit-scrollbar-thumb,
body::-webkit-scrollbar-thumb,
body *::-webkit-scrollbar-thumb {
  min-height: 24px;
  border: 2px solid transparent;
  border-radius: 999px;
  background-color: var(--reading-scrollbar-thumb);
  background-clip: padding-box;
}`;
}
