import { describe, expect, it, vi } from 'vitest';

import { EpubBookDocument } from './epubBookDocument';
import type { ReadingProgress } from './readingProgress';
import type { FoliateViewHost } from './viewHost';

interface FakeHost extends FoliateViewHost {
  openedBytes: unknown;
  initLocation: unknown;
  cfis: string[];
  contentData: Array<{ type: string; data: string }>;
  emitRelocate: (cfi: string) => void;
  emitProgress: (progress: ReadingProgress) => void;
  emitContentData: (type: string, data: string) => void;
  emitInternalLink: (href: string) => void;
  emitExternalLink: (href: string) => void;
  emitReadError: (error: unknown) => void;
  closed: boolean;
  emitContentDuringOpen: boolean;
}

function createFakeHost(): FakeHost {
  const relocateListeners: Array<(cfi: string) => void> = [];
  const progressListeners: Array<(progress: ReadingProgress) => void> = [];
  const contentListeners: Array<(type: string, data: string) => string> = [];
  const internalLinkListeners: Array<(href: string) => void> = [];
  const externalLinkListeners: Array<(href: string) => void> = [];
  const readErrorListeners: Array<(error: unknown) => void> = [];
  const host: FakeHost = {
    openedBytes: undefined,
    initLocation: undefined,
    cfis: [] as string[],
    contentData: [] as Array<{ type: string; data: string }>,
    closed: false,
    emitContentDuringOpen: false,
    getReadingProgress() {
      return null;
    },
    async open(book: unknown) {
      this.openedBytes = book;
      if (this.emitContentDuringOpen) {
        this.emitContentData(
          'application/xhtml+xml',
          '<html xmlns="http://www.w3.org/1999/xhtml"><body><script>alert(1)</script><p>首章</p></body></html>',
        );
      }
    },
    async init(location: unknown) {
      this.initLocation = location;
    },
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
        { label: '第一章', href: 'chapter1.xhtml', subitems: null },
        { label: '第二章', href: 'chapter2.xhtml', subitems: null },
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
      return () => {
        const index = relocateListeners.indexOf(listener);
        if (index >= 0) relocateListeners.splice(index, 1);
      };
    },
    onProgressChange(listener: (progress: ReadingProgress) => void) {
      progressListeners.push(listener);
      return () => {
        const index = progressListeners.indexOf(listener);
        if (index >= 0) progressListeners.splice(index, 1);
      };
    },
    onInternalLink(listener: (href: string) => void) {
      internalLinkListeners.push(listener);
      return () => {
        const index = internalLinkListeners.indexOf(listener);
        if (index >= 0) internalLinkListeners.splice(index, 1);
      };
    },
    onExternalLink(listener: (href: string) => void) {
      externalLinkListeners.push(listener);
      return () => {
        const index = externalLinkListeners.indexOf(listener);
        if (index >= 0) externalLinkListeners.splice(index, 1);
      };
    },
    onReadError(listener: (error: unknown) => void) {
      readErrorListeners.push(listener);
      return () => {
        const index = readErrorListeners.indexOf(listener);
        if (index >= 0) readErrorListeners.splice(index, 1);
      };
    },
    onContentData(listener: (type: string, data: string) => string) {
      contentListeners.push(listener);
      return () => {
        const index = contentListeners.indexOf(listener);
        if (index >= 0) contentListeners.splice(index, 1);
      };
    },
    getContentDocs() {
      return [];
    },
    onContentCreate() {
      return () => undefined;
    },
    async *search(options: import('./search').SearchOptions) {
      yield { kind: 'progress', progress: 1 } as const;
      yield { kind: 'match', match: { cfi: 'epubcfi(/6/1)', excerpt: { pre: '', match: options.query, post: '' } } } as const;
    },
    clearSearch() {},
    applyTypography() {},
    close() {
      this.closed = true;
    },
    emitRelocate(cfi: string) {
      for (const listener of relocateListeners) listener(cfi);
    },
    emitProgress(progress: ReadingProgress) {
      for (const listener of progressListeners) listener(progress);
    },
    emitContentData(type: string, data: string) {
      for (const listener of contentListeners) {
        this.contentData.push({ type, data: listener(type, data) });
      }
    },
    emitInternalLink(href: string) {
      for (const listener of internalLinkListeners) listener(href);
    },
    emitExternalLink(href: string) {
      for (const listener of externalLinkListeners) listener(href);
    },
    emitReadError(error: unknown) {
      for (const listener of readErrorListeners) listener(error);
    },
  };
  return host;
}

function createDocument(hostFactory: (container: HTMLElement) => FoliateViewHost) {
  return new EpubBookDocument({
    source: new File([new Uint8Array([1, 2, 3])], 'book.epub', {
      type: 'application/epub+zip',
    }),
    metadata: { title: '示例书', author: '作者', language: 'zh' },
    viewHostFactory: hostFactory,
  });
}

describe('EpubBookDocument', () => {
  it('打开文档时挂载宿主并传入惰性 EPUB 来源', async () => {
    const host = createFakeHost();
    const container = document.createElement('div');
    const book = new EpubBookDocument({
      source: new File([new Uint8Array([1, 2, 3])], 'book.epub', {
        type: 'application/epub+zip',
      }),
      metadata: { title: '示例书', author: '作者', language: 'zh' },
      viewHostFactory: () => host,
    });

    await book.open(container);

    expect(host.openedBytes).toBeInstanceOf(File);
    expect(book.getLocation()).toBeNull();
  });

  it('挂起后重新挂载同一宿主而不重复打开文档', async () => {
    const host = createFakeHost();
    const attach = vi.fn();
    const detach = vi.fn();
    host.attach = attach;
    host.detach = detach;
    const book = createDocument(() => host);
    const firstContainer = document.createElement('div');
    const secondContainer = document.createElement('div');

    await book.open(firstContainer);
    book.detach?.();

    expect(book.isRuntimeReady?.()).toBe(true);
    expect(detach).toHaveBeenCalledOnce();
    expect(book.attach?.(secondContainer)).toBe(true);
    expect(attach).toHaveBeenCalledWith(secondContainer);
    expect(host.openedBytes).toBeInstanceOf(File);
  });

  it('挂起时清除内容选择并让内容文档中的活动元素失焦', async () => {
    const host = createFakeHost();
    const contentDocument = document.implementation.createHTMLDocument('正文');
    const input = contentDocument.createElement('input');
    contentDocument.body.appendChild(input);
    input.focus();
    host.getContentDocs = () => [contentDocument];
    host.attach = vi.fn();
    host.detach = vi.fn();
    const book = createDocument(() => host);

    await book.open(document.createElement('div'));
    book.detach?.();

    expect(contentDocument.activeElement).toBe(contentDocument.body);
    expect(host.detach).toHaveBeenCalledOnce();
  });

  it('打开时复用调用方提供的来源', async () => {
    const host = createFakeHost();
    const source = new File([new Uint8Array([1, 2, 3])], 'book.epub', {
      type: 'application/epub+zip',
    });
    const book = new EpubBookDocument({
      source,
      metadata: { title: '示例书', author: '作者', language: 'zh' },
      viewHostFactory: () => host,
    });

    await book.open(document.createElement('div'));

    expect(host.openedBytes).toBe(source);
  });

  it('relocate 事件把 CFI 转成可序列化的 ReadingLocation 并通知订阅者', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    const listener = vi.fn();
    book.onLocationChange(listener);
    await book.open(document.createElement('div'));

    host.emitRelocate('epubcfi(/6/1)');

    expect(book.getLocation()).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/1)' });
    expect(listener).toHaveBeenCalledWith({ kind: 'epub', cfi: 'epubcfi(/6/1)' });
  });

  it('goToLocation 委托宿主导航并记录位置', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    await book.open(document.createElement('div'));

    await book.goToLocation({ kind: 'epub', cfi: 'epubcfi(/6/4)' });

    expect(host.cfis).toEqual(['epubcfi(/6/4)']);
    expect(book.getLocation()).toEqual({ kind: 'epub', cfi: 'epubcfi(/6/4)' });
  });

  it('精确定位后忽略窗口切换期间迟到的章节起点 relocate', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    const listener = vi.fn();
    book.onLocationChange(listener);
    await book.open(document.createElement('div'));
    const target = { kind: 'epub' as const, cfi: 'epubcfi(/6/2!/4,/2,/4/1:20)' };

    await book.goToLocation(target);
    host.emitRelocate('epubcfi(/6/2!/4)');

    expect(book.getLocation()).toEqual(target);
    expect(listener).not.toHaveBeenCalledWith({ kind: 'epub', cfi: 'epubcfi(/6/2!/4)' });
  });

  it('打开前订阅的位置反馈会在宿主就绪后继续转发', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    const listener = vi.fn();
    book.onProgressChange?.(listener);
    await book.open(document.createElement('div'));

    const progress: ReadingProgress = {
      fraction: 0.5,
      section: { current: 1, total: 2 },
      location: { current: 4, next: 5, total: 10 },
      tocLabel: '第二章',
      pageLabel: null,
    };
    host.emitProgress(progress);

    expect(book.getReadingProgress()).toEqual(progress);
    expect(listener).toHaveBeenCalledWith(progress);
  });

  it('next 与 prev 委托宿主翻页', async () => {
    const host = createFakeHost();
    const nextSpy = vi.spyOn(host, 'next');
    const prevSpy = vi.spyOn(host, 'prev');
    const book = createDocument(() => host);
    await book.open(document.createElement('div'));

    await book.next();
    await book.prev();

    expect(nextSpy).toHaveBeenCalledOnce();
    expect(prevSpy).toHaveBeenCalledOnce();
  });

  it('goToHref 委托宿主导航到书内链接', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    await book.open(document.createElement('div'));

    await book.goToHref('chapter1.xhtml');

    expect(host.cfis).toContain('chapter1.xhtml');
  });

  it('getTOC 返回宿主的分层目录', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    await book.open(document.createElement('div'));

    expect(book.getTOC()).toEqual([
      { label: '第一章', href: 'chapter1.xhtml', subitems: null },
      { label: '第二章', href: 'chapter2.xhtml', subitems: null },
    ]);
  });

  it('书内链接与外部链接事件被转发给上层订阅者', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    const internalListener = vi.fn();
    const externalListener = vi.fn();
    book.onInternalLink(internalListener);
    book.onExternalLink(externalListener);
    await book.open(document.createElement('div'));

    host.emitInternalLink('chapter2.xhtml');
    host.emitExternalLink('https://example.com');

    expect(internalListener).toHaveBeenCalledWith('chapter2.xhtml');
    expect(externalListener).toHaveBeenCalledWith('https://example.com');
  });

  it('打开后的宿主读取错误会转发给工作台诊断订阅者', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    const listener = vi.fn();
    book.onReadError?.(listener);

    await book.open(document.createElement('div'));
    const error = new Error('章节范围读取失败');
    host.emitReadError(error);

    expect(listener).toHaveBeenCalledWith(error);
  });

  it('search 委托宿主并返回渐进事件', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    await book.open(document.createElement('div'));

    const events: Array<{ kind: string; cfi?: string }> = [];
    for await (const event of book.search({ query: '关键词', matchCase: false })) {
      events.push(
        event.kind === 'progress'
          ? { kind: 'progress' }
          : { kind: 'match', cfi: event.match.cfi },
      );
    }

    expect(events).toEqual([{ kind: 'progress' }, { kind: 'match', cfi: 'epubcfi(/6/1)' }]);
  });

  it('clearSearch 委托宿主清除命中高亮', async () => {
    const host = createFakeHost();
    const clearSpy = vi.spyOn(host, 'clearSearch');
    const book = createDocument(() => host);
    await book.open(document.createElement('div'));

    book.clearSearch();
    expect(clearSpy).toHaveBeenCalledOnce();
  });

  it('close 销毁宿主并清空状态', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    await book.open(document.createElement('div'));
    host.emitRelocate('epubcfi(/6/1)');

    book.close();

    expect(host.closed).toBe(true);
    expect(book.getLocation()).toBeNull();
  });

  it('清洗 XHTML、SVG、CSS 与媒体内容,移除主动内容和远程资源', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    await book.open(document.createElement('div'));

    host.emitContentData(
      'application/xhtml+xml',
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><script>alert(1)</script><p>正文</p><a href="javascript:x">坏</a></body></html>`,
    );

    const xhtml = host.contentData.find((item) => item.type === 'application/xhtml+xml');
    expect(xhtml?.data).not.toContain('<script');
    expect(xhtml?.data).not.toContain('javascript:');
    expect(xhtml?.data).toContain('正文');

    host.emitContentData(
      'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><text>图形</text></svg>',
    );
    host.emitContentData(
      'text/css',
      '.cover { background: url("https://evil.example/track.png") }',
    );

    const svg = host.contentData.find((item) => item.type === 'image/svg+xml');
    const css = host.contentData.find((item) => item.type === 'text/css');
    expect(svg?.data).not.toContain('<script');
    expect(svg?.data).not.toContain('onload');
    expect(svg?.data).toContain('图形');
    expect(css?.data).not.toContain('evil.example');
  });

  it('在 view.open 消费首章前就接入内容清洗器', async () => {
    const host = createFakeHost();
    host.emitContentDuringOpen = true;
    const book = createDocument(() => host);

    await book.open(document.createElement('div'));

    expect(host.contentData[0]?.data).not.toContain('<script');
    expect(host.contentData[0]?.data).toContain('首章');
  });

  it('在 host 就绪前订阅的内容创建监听会在打开后转发给 host', async () => {
    const host = createFakeHost();
    const forwarded: Array<(doc: Document) => void> = [];
    host.onContentCreate = (listener: (doc: Document) => void) => {
      forwarded.push(listener);
      return () => undefined;
    };
    const book = createDocument(() => host);
    const listener = vi.fn();

    // 模拟组件在 open() 完成前订阅(此时 host 尚未创建)。
    book.onContentCreate(listener);
    await book.open(document.createElement('div'));

    // host 就绪后缓冲的订阅被转发到 host,后续内容创建事件才会到达面板。
    expect(forwarded).toHaveLength(1);
  });
});
