import { describe, expect, it } from 'vitest';

import {
  EPUB_THEME_BLACK_VARIABLE,
  REFLOWABLE_READER_THEME_PALETTES,
  buildPureBlackColorAttributeSelectors,
  isWorkbenchThemedReflowableFormat,
  transformReflowableEpubThemeResource,
} from './epubTheme';

describe('可重排 EPUB 全局主题样式兼容', () => {
  it('只把精确纯黑的 color 声明改成可逆变量', () => {
    const css = transformReflowableEpubThemeResource(
      'text/css',
      [
        'p { color: #000; }',
        '.gray { color: #777777; }',
        '.near-black { color: #000001; }',
        '.spaced-rgb { color: rgb(0,  0,  0); }',
        '.spaced-rgba { color: rgba(0,  0,  0,  1); }',
        '.bg { background-color: #000; }',
        '.named { color: black !important; }',
      ].join('\n'),
    );

    expect(css).toContain(`color: var(${EPUB_THEME_BLACK_VARIABLE});`);
    expect(css).toContain(`color: var(${EPUB_THEME_BLACK_VARIABLE}) !important;`);
    expect(css.match(new RegExp(`color: var\\(${EPUB_THEME_BLACK_VARIABLE}\\)`, 'g'))).toHaveLength(4);
    expect(css).toContain('.gray { color: #777777; }');
    expect(css).toContain('.near-black { color: #000001; }');
    expect(css).toContain('.bg { background-color: #000; }');
  });

  it('保留彩色内联样式、局部背景、SVG 和旧式 color 属性', () => {
    const xhtml = transformReflowableEpubThemeResource(
      'application/xhtml+xml',
      `<html xmlns="http://www.w3.org/1999/xhtml"><body>
        <p style="color: black; background: #000">普通</p>
        <p style="color: #ff0000">彩色</p>
        <font color="#000001">相近黑色</font>
        <font color="#000000">旧式纯黑</font>
        <svg xmlns="http://www.w3.org/2000/svg"><text style="color: #000">图形</text></svg>
      </body></html>`,
    );

    expect(xhtml).toContain(`color: var(${EPUB_THEME_BLACK_VARIABLE})`);
    expect(xhtml).toContain('color: #ff0000');
    expect(xhtml).toContain('background: #000');
    expect(xhtml).toContain('color="#000001"');
    expect(xhtml).toContain('color="#000000"');
    expect(xhtml).toContain('color: #000');
  });

  it('五套主题使用工作台正文纸张令牌，科技黑纯白，其余纯黑', () => {
    expect(REFLOWABLE_READER_THEME_PALETTES).toMatchObject({
      midnight: { background: '#1e2023', foreground: '#ffffff' },
      apple: { background: '#ffffff', foreground: '#000000' },
      claude: { background: '#fbf7ef', foreground: '#000000' },
      mint: { background: '#f9fcfa', foreground: '#000000' },
      rose: { background: '#fffafd', foreground: '#000000' },
    });
  });

  it('只把可重排 EPUB 与 Markdown 纳入工作台主题范围', () => {
    expect(isWorkbenchThemedReflowableFormat('epub')).toBe(true);
    expect(isWorkbenchThemedReflowableFormat('markdown')).toBe(true);
    expect(isWorkbenchThemedReflowableFormat('pdf')).toBe(false);
    expect(isWorkbenchThemedReflowableFormat('unknown')).toBe(false);
  });

  it('纯黑属性选择器排除 SVG 内容', () => {
    expect(buildPureBlackColorAttributeSelectors()).toContain(
      ':not(svg):not(svg *)[color="#000" i]',
    );
  });
});
