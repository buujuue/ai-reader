import { beforeEach, describe, expect, it } from 'vitest';

import { useMarkdownSessionStore } from './markdownSessionStore';

describe('MarkdownDocumentSession Store', () => {
  beforeEach(() => {
    useMarkdownSessionStore.getState().resetToDefault();
  });

  it('打开一个材料会话;重复打开保留现有缓冲区', () => {
    useMarkdownSessionStore.getState().openSession('mat-1', '第一版', 0);
    useMarkdownSessionStore.getState().openSession('mat-1', '不应覆盖', 0);

    const session = useMarkdownSessionStore.getState().getSession('mat-1');
    expect(session).toEqual({
      materialId: 'mat-1',
      text: '第一版',
      dirty: false,
      savedVersion: 0,
    });
  });

  it('更新文本会标记为脏', () => {
    useMarkdownSessionStore.getState().openSession('mat-1', '第一版', 0);

    useMarkdownSessionStore.getState().updateText('mat-1', '修改后的文本');

    const session = useMarkdownSessionStore.getState().getSession('mat-1');
    expect(session?.text).toBe('修改后的文本');
    expect(session?.dirty).toBe(true);
  });

  it('markSaved 清除脏标记并更新已保存版本', () => {
    useMarkdownSessionStore.getState().openSession('mat-1', '第一版', 0);
    useMarkdownSessionStore.getState().updateText('mat-1', '修改后的文本');

    useMarkdownSessionStore.getState().markSaved('mat-1', 1);

    const session = useMarkdownSessionStore.getState().getSession('mat-1');
    expect(session?.dirty).toBe(false);
    expect(session?.savedVersion).toBe(1);
    expect(session?.text).toBe('修改后的文本');
  });

  it('discard 把缓冲区回退到已保存文本并清除脏标记', () => {
    useMarkdownSessionStore.getState().openSession('mat-1', '第一版', 0);
    useMarkdownSessionStore.getState().updateText('mat-1', '修改后的文本');

    useMarkdownSessionStore.getState().discard('mat-1', '第一版');

    const session = useMarkdownSessionStore.getState().getSession('mat-1');
    expect(session?.text).toBe('第一版');
    expect(session?.dirty).toBe(false);
  });

  it('不同材料各自持有独立缓冲区', () => {
    useMarkdownSessionStore.getState().openSession('mat-1', '甲', 0);
    useMarkdownSessionStore.getState().openSession('mat-2', '乙', 0);

    useMarkdownSessionStore.getState().updateText('mat-1', '甲改');

    expect(useMarkdownSessionStore.getState().getSession('mat-1')?.text).toBe('甲改');
    expect(useMarkdownSessionStore.getState().getSession('mat-2')?.text).toBe('乙');
  });
});