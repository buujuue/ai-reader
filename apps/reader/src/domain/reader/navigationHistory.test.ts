import { describe, expect, it } from 'vitest';

import type { ReadingLocation } from './readingLocation';
import {
  MAX_NAVIGATION_HISTORY,
  back,
  canGoBack,
  canGoForward,
  createNavigationHistory,
  currentLocation,
  forward,
  pushExplicit,
  replaceCurrent,
} from './navigationHistory';

function loc(cfi: string): ReadingLocation {
  return { kind: 'epub', cfi };
}

describe('NavigationHistory', () => {
  it('空历史没有当前位置,也不能后退或前进', () => {
    const history = createNavigationHistory();
    expect(currentLocation(history)).toBeNull();
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(false);
  });

  it('显式跳转压入首个节点并成为当前位置', () => {
    const history = createNavigationHistory();
    const next = pushExplicit(history, loc('epubcfi(/6/4)'));
    expect(currentLocation(next)).toEqual(loc('epubcfi(/6/4)'));
    expect(canGoBack(next)).toBe(false);
  });

  it('普通翻页只替换当前节点,不新增历史', () => {
    let history = createNavigationHistory();
    history = pushExplicit(history, loc('epubcfi(/6/4)'));
    history = replaceCurrent(history, loc('epubcfi(/6/5)'));
    expect(currentLocation(history)).toEqual(loc('epubcfi(/6/5)'));
    expect(canGoBack(history)).toBe(false);
  });

  it('多次显式跳转后支持后退与前进', () => {
    let history = createNavigationHistory();
    history = pushExplicit(history, loc('epubcfi(/6/1)'));
    history = pushExplicit(history, loc('epubcfi(/6/2)'));
    history = pushExplicit(history, loc('epubcfi(/6/3)'));

    expect(currentLocation(history)).toEqual(loc('epubcfi(/6/3)'));
    expect(canGoBack(history)).toBe(true);

    const backOne = back(history);
    expect(backOne).toBeDefined();
    expect(currentLocation(backOne!.history)).toEqual(loc('epubcfi(/6/2)'));
    expect(canGoForward(backOne!.history)).toBe(true);

    const forwardOne = forward(backOne!.history);
    expect(forwardOne).toBeDefined();
    expect(currentLocation(forwardOne!.history)).toEqual(loc('epubcfi(/6/3)'));
  });

  it('连续显式跳转后新增节点会截断前进分支', () => {
    let history = createNavigationHistory();
    history = pushExplicit(history, loc('epubcfi(/6/1)'));
    history = pushExplicit(history, loc('epubcfi(/6/2)'));
    history = pushExplicit(history, loc('epubcfi(/6/3)'));
    const backOne = back(history)!;

    const jumped = pushExplicit(backOne.history, loc('epubcfi(/6/9)'));
    expect(currentLocation(jumped)).toEqual(loc('epubcfi(/6/9)'));
    expect(canGoForward(jumped)).toBe(false);
    expect(canGoBack(jumped)).toBe(true);
  });

  it('在最前位置不能后退,在最后位置不能前进', () => {
    let history = createNavigationHistory();
    history = pushExplicit(history, loc('epubcfi(/6/1)'));
    expect(back(history)).toBeNull();
    expect(canGoForward(history)).toBe(false);
  });

  it('当历史节点数超过上限时丢弃最旧节点', () => {
    let history = createNavigationHistory();
    for (let i = 0; i < MAX_NAVIGATION_HISTORY + 5; i += 1) {
      history = pushExplicit(history, loc(`epubcfi(/6/${i})`));
    }
    const positions = history.positions;
    expect(positions.length).toBe(MAX_NAVIGATION_HISTORY);
    expect(positions[0]).toEqual(loc('epubcfi(/6/5)'));
    expect(currentLocation(history)).toEqual(loc(`epubcfi(/6/${MAX_NAVIGATION_HISTORY + 4})`));
  });

  it('后退后普通翻页只替换当前节点,保留前进分支', () => {
    let history = createNavigationHistory();
    history = pushExplicit(history, loc('epubcfi(/6/1)'));
    history = pushExplicit(history, loc('epubcfi(/6/2)'));
    const backOne = back(history)!;
    const replaced = replaceCurrent(backOne.history, loc('epubcfi(/6/1#a)'));
    expect(currentLocation(replaced)).toEqual(loc('epubcfi(/6/1#a)'));
    expect(canGoBack(replaced)).toBe(false);
    expect(canGoForward(replaced)).toBe(true);
  });
});