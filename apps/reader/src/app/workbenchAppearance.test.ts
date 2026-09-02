import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WORKBENCH_APPEARANCE,
  WORKBENCH_THEMES,
  WORKBENCH_APPEARANCE_STORAGE_KEY,
  createLocalStorageWorkbenchAppearancePreferences,
  normalizeWorkbenchAppearance,
} from './workbenchAppearance';

describe('工作台外观本机偏好', () => {
  it('提供五套原型主题并默认开启背景光', () => {
    expect(WORKBENCH_THEMES.map((theme) => theme.id)).toEqual([
      'midnight',
      'apple',
      'claude',
      'mint',
      'rose',
    ]);
    expect(DEFAULT_WORKBENCH_APPEARANCE).toEqual({ theme: 'midnight', glowEnabled: true });
  });

  it('缺失、非法或损坏的偏好安全回退到极夜黑与开启背景光', () => {
    expect(normalizeWorkbenchAppearance(null)).toEqual(DEFAULT_WORKBENCH_APPEARANCE);
    expect(normalizeWorkbenchAppearance({ theme: 'neon', glowEnabled: false })).toEqual(
      DEFAULT_WORKBENCH_APPEARANCE,
    );

    const storage = {
      getItem: vi.fn(() => '{bad json'),
      setItem: vi.fn(),
    };
    expect(createLocalStorageWorkbenchAppearancePreferences(storage).load()).toEqual(
      DEFAULT_WORKBENCH_APPEARANCE,
    );
  });

  it('只在本机偏好存储中保存主题和背景光', () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    };
    const preferences = createLocalStorageWorkbenchAppearancePreferences(storage);

    preferences.save({ theme: 'claude', glowEnabled: false });

    expect(storage.setItem).toHaveBeenCalledWith(
      WORKBENCH_APPEARANCE_STORAGE_KEY,
      JSON.stringify({ theme: 'claude', glowEnabled: false }),
    );
  });
});
