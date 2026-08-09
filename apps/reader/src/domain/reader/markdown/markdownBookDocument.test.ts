import { describe, expect, it, vi } from 'vitest';

import { MarkdownBookDocument } from './markdownBookDocument';
import type { FoliateViewHost } from '../viewHost';

function createFakeHost(): FoliateViewHost & {
  openedBytes: unknown;
  cfis: string[];
  emitRelocate: (cfi: string) => void;
  closed: boolean;
} {
  const relocateListeners: Array<(cfi: string) => void> = [];
  const host = {
    openedBytes: undefined as unknown,
    cfis: [] as string[],
    closed: false,
    async open(book: unknown) {
      this.openedBytes = book;
    },
    async init() {},
    async next() {},
    async prev() {},
    async goToLocation(location: unknown) {
      this.cfis.push(location as string);
    },
    async goToHref(href: string) {
      this.cfis.push(href);
    },
    getTOC() {
      return [
        { label: '第一章', href: 'section1.xhtml#md-section-1', subitems: null },
        { label: '第二章', href: 'section2.xhtml#md-section-2', subitems: null },
      ];
    },
    getCurrentCFI() {
      return this.cfis.at(-1) ?? null;
    },
    getCFI() {
      return 'epubcfi(/6/1)';
    },
    getCurrentIndex() {
      return 0;
    },
    addAnnotation() {},
    removeAnnotation() {},
    onShowAnnotation() {
      return () => undefined;
    },
    onRelocate(listener: (cfi: string) => void) {
      relocateListeners.push(listener);
      return () => undefined;
    },
    onInternalLink() {
      return () => undefined;
    },
    onExternalLink() {
      return () => undefined;
    },
    onContentData() {
      return () => undefined;
    },
    getContentDocs() {
      return [];
    },
    onContentCreate() {
      return () => undefined;
    },
    async *search(_options: import('../search').SearchOptions) {
      yield { kind: 'progress', progress: 1 } as const;
      yield {
        kind: 'match',
        match: { cfi: 'epubcfi(/6/2/1)', excerpt: { pre: '', match: '词', post: '' } },
      } as const;
    },
    clearSearch() {},
    applyTypography() {},
    close() {
      this.closed = true;
    },
    emitRelocate(cfi: string) {
      for (const listener of relocateListeners) listener(cfi);
    },
  };
  return host;
}

function createDocument(host: FoliateViewHost) {
  return new MarkdownBookDocument({
    text: '# 第一章\n\n正文一\n\n# 第二章\n\n正文二',
    metadata: { title: '手册', author: '作者', language: 'zh' },
    viewHostFactory: () => host,
  });
}

describe('MarkdownBookDocument', () => {
  it('打开时把 Markdown 组装成内存 EPUB 并交给宿主', async () => {
    const host = createFakeHost();
    const book = createDocument(host);
    await book.open(document.createElement('div'));

    expect(host.openedBytes).toBeInstanceOf(File);
    expect(book.format).toBe('markdown');
  });

  it('relocate 事件把 CFI 转成 markdown ReadingLocation', async () => {
    const host = createFakeHost();
    const book = createDocument(host);
    const listener = vi.fn();
    book.onLocationChange(listener);
    await book.open(document.createElement('div'));

    host.emitRelocate('epubcfi(/6/2)');

    expect(book.getLocation()).toEqual({ kind: 'markdown', cfi: 'epubcfi(/6/2)' });
    expect(listener).toHaveBeenCalledWith({ kind: 'markdown', cfi: 'epubcfi(/6/2)' });
  });

  it('goToLocation 接受 markdown 位置并委托宿主', async () => {
    const host = createFakeHost();
    const book = createDocument(host);
    await book.open(document.createElement('div'));

    await book.goToLocation({ kind: 'markdown', cfi: 'epubcfi(/6/4)' });

    expect(host.cfis).toContain('epubcfi(/6/4)');
    expect(book.getLocation()).toEqual({ kind: 'markdown', cfi: 'epubcfi(/6/4)' });
  });

  it('拒绝其它 kind 的阅读位置', async () => {
    const host = createFakeHost();
    const book = createDocument(host);
    await book.open(document.createElement('div'));

    await expect(
      book.goToLocation({ kind: 'epub', cfi: 'epubcfi(/6/1)' }),
    ).rejects.toThrow('不支持的阅读位置类型');
  });

  it('getTOC 返回目录(复用 EPUB 宿主)', async () => {
    const host = createFakeHost();
    const book = createDocument(host);
    await book.open(document.createElement('div'));

    expect(book.getTOC()).toEqual([
      { label: '第一章', href: 'section1.xhtml#md-section-1', subitems: null },
      { label: '第二章', href: 'section2.xhtml#md-section-2', subitems: null },
    ]);
  });

  it('search 委托宿主并返回命中,close 销毁宿主', async () => {
    const host = createFakeHost();
    const book = createDocument(host);
    await book.open(document.createElement('div'));

    const events: Array<{ kind: string }> = [];
    for await (const event of book.search({ query: '词', matchCase: false })) {
      events.push({ kind: event.kind });
    }
    expect(events).toEqual([{ kind: 'progress' }, { kind: 'match' }]);

    book.close();
    expect(host.closed).toBe(true);
  });
});