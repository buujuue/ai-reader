/**
 * 可重排阅读正文使用的全局主题令牌。
 *
 * 这些值与工作台外观 CSS 中的 `--prototype-page` 保持一致，但主题身份
 * 和正文配色属于阅读领域，因此由工作台外观元数据消费，而不是反向依赖
 * React 或 CSS 文件。固定版式材料不会使用这组令牌。
 */
export type ReflowableReaderThemeId = 'midnight' | 'apple' | 'claude' | 'mint' | 'rose';

export interface ReflowableReaderThemePalette {
  /** 页面基础背景，必须是不透明的正文纸张色。 */
  background: string;
  /** 普通正文与明确纯黑声明的目标颜色。 */
  foreground: '#ffffff' | '#000000';
}

export const REFLOWABLE_READER_THEME_PALETTES: Record<
  ReflowableReaderThemeId,
  ReflowableReaderThemePalette
> = {
  midnight: { background: '#1e2023', foreground: '#ffffff' },
  apple: { background: '#ffffff', foreground: '#000000' },
  claude: { background: '#fbf7ef', foreground: '#000000' },
  mint: { background: '#f9fcfa', foreground: '#000000' },
  rose: { background: '#fffafd', foreground: '#000000' },
};

export const DEFAULT_REFLOWABLE_READER_THEME: ReflowableReaderThemeId = 'midnight';

/** 书内原始纯黑声明映射到当前全局主题前景色的变量。 */
export const EPUB_THEME_BLACK_VARIABLE = '--ai-reader-epub-theme-black';

const PURE_BLACK_VALUES = new Set([
  'black',
  '#000',
  '#000000',
  'rgb(0,0,0)',
  'rgb(0, 0, 0)',
  'rgb(0 0 0)',
  'rgba(0,0,0,1)',
  'rgba(0, 0, 0, 1)',
  'rgba(0 0 0 / 1)',
]);

const PURE_BLACK_COLOR_ATTRIBUTES = [
  'black',
  '#000',
  '#000000',
  'rgb(0,0,0)',
  'rgb(0, 0, 0)',
  'rgb(0 0 0)',
];

function normalizeColorValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s*!important\s*$/i, '');
}

function isPureBlackValue(value: string): boolean {
  return PURE_BLACK_VALUES.has(normalizeColorValue(value));
}

/**
 * 只改写 CSS 的 `color` 声明，避免把 background-color、相近色值或其它
 * 属性误认为正文颜色。`!important` 会被保留，声明本身仍属于原书样式。
 */
export function replacePureBlackCssColors(css: string): string {
  return css.replace(
    /(^|[;{])(\s*)(color)(\s*:\s*)([^;{}]+)(?=;|})/gi,
    (match, prefix: string, whitespace: string, property: string, separator: string, value: string) => {
      if (!isPureBlackValue(value)) return match;
      const important = /\s*!important\s*$/i.test(value) ? ' !important' : '';
      return `${prefix}${whitespace}${property}${separator}var(${EPUB_THEME_BLACK_VARIABLE})${important}`;
    },
  );
}

function isSvgElement(element: Element): boolean {
  return element.namespaceURI === 'http://www.w3.org/2000/svg' ||
    element.closest('svg') !== null;
}

/**
 * 为 HTML/XHTML 中的内联样式和 style 元素接入可逆的主题变量。
 * SVG 内容跳过，避免把图形填充/描边误当作正文颜色。
 */
export function replacePureBlackXhtmlColors(input: string): string {
  const parsed = new DOMParser().parseFromString(input, 'application/xhtml+xml');
  if (!parsed.documentElement || parsed.getElementsByTagName('parsererror').length > 0) {
    return input;
  }

  for (const element of Array.from(parsed.querySelectorAll('[style], style'))) {
    if (isSvgElement(element)) continue;
    if (element.localName.toLowerCase() === 'style') {
      element.textContent = replacePureBlackCssColors(element.textContent ?? '');
    } else {
      const style = element.getAttribute('style');
      if (style !== null) element.setAttribute('style', replacePureBlackCssColors(style));
    }
  }
  return new XMLSerializer().serializeToString(parsed);
}

/**
 * 对资源类型执行主题兼容转换。SVG 本体不改；XHTML 中的旧式 `color`
 * 属性由注入 CSS 的精确属性选择器处理，因此相近色值不会被误匹配。
 */
export function transformReflowableEpubThemeResource(type: string, input: string): string {
  const mediaType = type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType === 'text/css') return replacePureBlackCssColors(input);
  if (mediaType === 'application/xhtml+xml' || mediaType === 'text/html') {
    return replacePureBlackXhtmlColors(input);
  }
  return input;
}

/** 精确识别旧式 HTML color 属性中的纯黑值，不匹配相近色或背景属性。 */
export function buildPureBlackColorAttributeSelectors(): string {
  return PURE_BLACK_COLOR_ATTRIBUTES
    .map((value) => `[color="${value}" i]`)
    .join(',\n');
}
