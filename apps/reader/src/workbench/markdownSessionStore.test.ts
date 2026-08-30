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

  it('正式版本不一致时可用托管正文校准会话并清除旧脏内容', () => {
    useMarkdownSessionStore.getState().openSession('mat-1', '旧版本', 0);
    useMarkdownSessionStore.getState().updateText('mat-1', '未保存旧修改');

    useMarkdownSessionStore.getState().replaceFormalText('mat-1', '正式版本 1', 1);

    expect(useMarkdownSessionStore.getState().getSession('mat-1')).toEqual({
      materialId: 'mat-1',
      text: '正式版本 1',
      dirty: false,
      savedVersion: 1,
    });
  });

  it('更新文本会标记为脏', () => {
    useMarkdownSessionStore.getState().openSession('mat-1', '第一版', 0);

    useMarkdownSessionStore.getState().updateText('mat-1', '修改后的文本');

    const session = useMarkdownSessionStore.getState().getSession('mat-1');
    expect(session?.text).toBe('修改后的文本');
    expect(session?.dirty).toBe(true);
  });

  it('recordFormalSave 在缓冲区未变化时清除脏标记并更新已保存版本', () => {
    useMarkdownSessionStore.getState().openSession('mat-1', '第一版', 0);
    useMarkdownSessionStore.getState().updateText('mat-1', '修改后的文本');

    const unchanged = useMarkdownSessionStore
      .getState()
      .recordFormalSave('mat-1', '修改后的文本', 1);

    expect(unchanged).toBe(true);
    const session = useMarkdownSessionStore.getState().getSession('mat-1');
    expect(session?.dirty).toBe(false);
    expect(session?.savedVersion).toBe(1);
    expect(session?.text).toBe('修改后的文本');
  });

  it('recordFormalSave 在保存期间又有输入时保留脏标记并升级基础版本', () => {
    useMarkdownSessionStore.getState().openSession('mat-1', '# original', 0);
    useMarkdownSessionStore.getState().updateText('mat-1', '# saving');
    useMarkdownSessionStore.getState().updateText('mat-1', '# latest');

    const unchanged = useMarkdownSessionStore
      .getState()
      .recordFormalSave('mat-1', '# saving', 1);

    expect(unchanged).toBe(false);
    expect(useMarkdownSessionStore.getState().getSession('mat-1')).toMatchObject({
      text: '# latest',
      dirty: true,
      savedVersion: 1,
    });
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
