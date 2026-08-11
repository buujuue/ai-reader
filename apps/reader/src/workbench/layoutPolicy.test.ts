import { describe, expect, it } from 'vitest';

import {
  COMPACT_LAYOUT_MAX_WIDTH,
  getLayoutPolicy,
  getVisibleSidebars,
} from './layoutPolicy';

describe('getLayoutPolicy', () => {
  it('在紧凑容器中使用覆盖抽屉并只展示活动编辑器组', () => {
    const policy = getLayoutPolicy(COMPACT_LAYOUT_MAX_WIDTH - 1);

    expect(policy).toMatchObject({
      mode: 'compact',
      sidebarPresentation: 'overlay',
      showAllEditorGroups: false,
    });
  });

  it('在平板横屏和桌面容器中保留行内侧栏与全部编辑器组', () => {
    expect(getLayoutPolicy(COMPACT_LAYOUT_MAX_WIDTH)).toMatchObject({
      mode: 'medium',
      sidebarPresentation: 'inline',
      showAllEditorGroups: true,
    });
    expect(getLayoutPolicy(1280)).toMatchObject({
      mode: 'wide',
      sidebarPresentation: 'inline',
      showAllEditorGroups: true,
    });
  });

  it('对无效宽度安全降级为紧凑布局', () => {
    expect(getLayoutPolicy(Number.NaN).mode).toBe('compact');
  });

  it('中等布局和紧凑布局只投影一个侧栏期望状态', () => {
    const visibility = { primary: true, toc: true, annotation: true };

    expect(getVisibleSidebars(getLayoutPolicy(900), visibility)).toEqual(['primary']);
    expect(getVisibleSidebars(getLayoutPolicy(700), visibility, 'toc')).toEqual(['toc']);
    expect(getVisibleSidebars(getLayoutPolicy(1280), visibility)).toEqual([
      'primary',
      'toc',
      'annotation',
    ]);
  });
});
