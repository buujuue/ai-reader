import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_WORKBENCH_APPEARANCE } from '../app/workbenchAppearance';
import { useWorkbenchAppearanceStore } from './appearanceStore';

describe('工作台外观 Store', () => {
  beforeEach(() => {
    useWorkbenchAppearanceStore.getState().resetToDefault();
  });

  it('只持有本机外观，不污染阅读排版或工作区字段', () => {
    expect(useWorkbenchAppearanceStore.getState()).toMatchObject(DEFAULT_WORKBENCH_APPEARANCE);
    expect(useWorkbenchAppearanceStore.getState()).not.toHaveProperty('globalReadingTypography');
  });

  it('恢复偏好时归一化非法值并支持独立切换背景光', () => {
    useWorkbenchAppearanceStore.getState().hydrate({ theme: 'mint', glowEnabled: false });
    useWorkbenchAppearanceStore.getState().setTheme('rose');

    expect(useWorkbenchAppearanceStore.getState()).toMatchObject({
      theme: 'rose',
      glowEnabled: false,
    });
  });
});
