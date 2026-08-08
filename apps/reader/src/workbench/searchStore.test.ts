import { describe, expect, it } from 'vitest';

import { useSearchStore } from './searchStore';

const VIEW = 'view-1';

function match(cfi: string) {
  return { cfi, excerpt: { pre: '', match: 'x', post: '' } };
}

describe('searchStore', () => {
  it('open 激活搜索栏,close 丢弃该视图状态', () => {
    const store = useSearchStore.getState();
    store.open(VIEW);
    expect(useSearchStore.getState().getView(VIEW).active).toBe(true);

    store.addMatch(VIEW, match('epubcfi(/6/1)'));
    store.close(VIEW);
    expect(useSearchStore.getState().getView(VIEW).active).toBe(false);
    expect(useSearchStore.getState().getView(VIEW).matches).toHaveLength(0);
  });

  it('begin 重置状态并进入 searching', () => {
    const store = useSearchStore.getState();
    store.open(VIEW);
    store.addMatch(VIEW, match('epubcfi(/6/1)'));
    store.setCurrentIndex(VIEW, 0);

    store.begin(VIEW, '关键词', true);

    const view = useSearchStore.getState().getView(VIEW);
    expect(view.status).toBe('searching');
    expect(view.query).toBe('关键词');
    expect(view.matchCase).toBe(true);
    expect(view.matches).toHaveLength(0);
    expect(view.currentIndex).toBe(-1);
    expect(view.progress).toBe(0);
  });

  it('searching 期间累积进度与命中,complete 结束', () => {
    const store = useSearchStore.getState();
    store.begin(VIEW, '关键词', false);
    store.setProgress(VIEW, 0.5);
    store.addMatch(VIEW, match('epubcfi(/6/1)'));
    store.setCurrentIndex(VIEW, 0);
    store.complete(VIEW);

    const view = useSearchStore.getState().getView(VIEW);
    expect(view.progress).toBe(1);
    expect(view.status).toBe('completed');
    expect(view.matches).toEqual([match('epubcfi(/6/1)')]);
    expect(view.currentIndex).toBe(0);
    expect(view.currentCfi).toBe('epubcfi(/6/1)');
  });

  it('setCurrentIndex 记录当前命中 CFI', () => {
    const store = useSearchStore.getState();
    store.begin(VIEW, '关键词', false);
    store.addMatch(VIEW, match('a'));
    store.addMatch(VIEW, match('b'));
    store.setCurrentIndex(VIEW, 1);

    expect(useSearchStore.getState().getView(VIEW).currentCfi).toBe('b');
  });
});