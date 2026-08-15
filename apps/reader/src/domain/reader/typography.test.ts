import { describe, expect, it } from 'vitest';

import {
  DEFAULT_READING_TYPOGRAPHY,
  buildTypographyCss,
  isReadingTypography,
  isTypographyOverride,
  resolveTypography,
} from './typography';

describe('阅读排版', () => {
  it('全局默认是完整且合法的排版设置', () => {
    expect(isReadingTypography(DEFAULT_READING_TYPOGRAPHY)).toBe(true);
  });

  it('默认模式为分页、浅色、无衬线、18px 字号', () => {
    expect(DEFAULT_READING_TYPOGRAPHY).toMatchObject({
      flow: 'paginated',
      theme: 'light',
      fontFamily: 'sansSerif',
      fontSize: 18,
      lineHeight: 1.6,
    });
  });

  it('isReadingTypography 拒绝缺失字段与非法枚举', () => {
    expect(isReadingTypography({ ...DEFAULT_READING_TYPOGRAPHY, fontSize: undefined })).toBe(false);
    expect(
      isReadingTypography({ ...DEFAULT_READING_TYPOGRAPHY, theme: 'neon' }),
    ).toBe(false);
    expect(isReadingTypography({ ...DEFAULT_READING_TYPOGRAPHY, flow: 'vertical' })).toBe(false);
    expect(isReadingTypography(null)).toBe(false);
  });

  it('isTypographyOverride 允许只覆盖部分字段的空对象', () => {
    expect(isTypographyOverride({})).toBe(true);
    expect(isTypographyOverride({ fontSize: 22 })).toBe(true);
    expect(isTypographyOverride({ fontSize: '22' })).toBe(false);
    expect(isTypographyOverride({ theme: 'dark' })).toBe(true);
    expect(isTypographyOverride({ flow: 'vertical' })).toBe(false);
    expect(isTypographyOverride(null)).toBe(false);
  });

  it('resolveTypography 用覆盖字段合并,未覆盖字段沿用全局默认', () => {
    const resolved = resolveTypography(DEFAULT_READING_TYPOGRAPHY, {
      fontSize: 24,
      theme: 'dark',
    });
    expect(resolved.fontSize).toBe(24);
    expect(resolved.theme).toBe('dark');
    expect(resolved.fontFamily).toBe(DEFAULT_READING_TYPOGRAPHY.fontFamily);
    expect(resolved.flow).toBe(DEFAULT_READING_TYPOGRAPHY.flow);
  });

  it('resolveTypography 无覆盖时直接返回全局默认', () => {
    expect(resolveTypography(DEFAULT_READING_TYPOGRAPHY, null)).toEqual(
      DEFAULT_READING_TYPOGRAPHY,
    );
    expect(resolveTypography(DEFAULT_READING_TYPOGRAPHY, undefined)).toEqual(
      DEFAULT_READING_TYPOGRAPHY,
    );
  });

  it('buildTypographyCss 注入固定字体与主题色,不拼接任意字符串', () => {
    const css = buildTypographyCss(DEFAULT_READING_TYPOGRAPHY);
    expect(css).toContain('font-size: 18px');
    expect(css).toContain('line-height: 1.6');
    expect(css).toContain('background-color: #ffffff');
    expect(css).toContain('color: #1f2937');
    expect(css).toContain('scrollbar-width: thin');
    expect(css).toContain('width: 8px');
    expect(css).toContain('background: transparent');
    // 字体来自固定映射,不包含用户可控的自由文本。
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('javascript:');
  });

  it('深色主题使用深色背景与浅色前景', () => {
    const css = buildTypographyCss({ ...DEFAULT_READING_TYPOGRAPHY, theme: 'dark' });
    expect(css).toContain('background-color: #18181b');
    expect(css).toContain('color: #e4e4e7');
  });
});
