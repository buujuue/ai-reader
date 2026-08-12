import { describe, expect, it } from 'vitest';

import { resolveAndroidBackAction, type AndroidBackState } from './androidBackButton';

const baseState: AndroidBackState = {
  compactLayout: true,
  visibleSidebars: [],
  activeViewId: 'view-1',
  activeViewSourceMode: false,
  activeSearchViewId: null,
  markdownDirtyCloseOpen: false,
  recoveryDialogOpen: false,
  metadataDialogOpen: false,
  purgeDialogOpen: false,
  externalLinkDialogOpen: false,
  typographyDialogOpen: false,
  noteDialogOpen: false,
};

describe('resolveAndroidBackAction', () => {
  it('先关闭脏 Markdown 确认框，不能把返回键解释成丢弃修改', () => {
    expect(
      resolveAndroidBackAction({
        ...baseState,
        markdownDirtyCloseOpen: true,
      }),
    ).toEqual({ kind: 'dismissMarkdownDirtyClose' });
  });

  it('关闭搜索和紧凑布局抽屉后才退出源码模式', () => {
    expect(
      resolveAndroidBackAction({
        ...baseState,
        activeViewSourceMode: true,
        activeSearchViewId: 'view-1',
        visibleSidebars: ['primary'],
      }),
    ).toEqual({ kind: 'closeSearch', viewId: 'view-1' });

    expect(
      resolveAndroidBackAction({
        ...baseState,
        activeViewSourceMode: true,
        visibleSidebars: ['toc'],
      }),
    ).toEqual({ kind: 'closeSidebar', sidebar: 'toc' });

    expect(
      resolveAndroidBackAction({
        ...baseState,
        activeViewSourceMode: true,
      }),
    ).toEqual({ kind: 'exitMarkdownSourceMode', viewId: 'view-1' });
  });

  it('在恢复对话框中保持当前界面，避免返回键静默丢弃快照', () => {
    expect(
      resolveAndroidBackAction({
        ...baseState,
        recoveryDialogOpen: true,
      }),
    ).toEqual({ kind: 'stay' });
  });

  it('非紧凑布局不把行内侧栏当作抽屉关闭', () => {
    expect(
      resolveAndroidBackAction({
        ...baseState,
        compactLayout: false,
        visibleSidebars: ['primary'],
      }),
    ).toEqual({ kind: 'delegateToWebView' });
  });

  it('没有次级状态时把返回键交给 WebView，由平台决定历史后退或退出', () => {
    expect(resolveAndroidBackAction(baseState)).toEqual({ kind: 'delegateToWebView' });
  });
});
