import { describe, expect, it, vi } from 'vitest';

import { EpubBookDocument } from './epubBookDocument';
import type { FoliateViewHost } from './viewHost';

interface FakeHost extends FoliateViewHost {
  openedBytes: unknown;
  initLocation: unknown;
  cfis: string[];
  contentData: Array<{ type: string; data: string }>;
  emitRelocate: (cfi: string) => void;
  emitContentData: (type: string, data: string) => void;
  closed: boolean;
}

function createFakeHost(): FakeHost {
  const relocateListeners: Array<(cfi: string) => void> = [];
  const contentListeners: Array<(type: string, data: string) => string> = [];
  const host: FakeHost = {
    openedBytes: undefined,
    initLocation: undefined,
    cfis: [] as string[],
    contentData: [] as Array<{ type: string; data: string }>,
    closed: false,
    async open(book: unknown) {
      this.openedBytes = book;
    },
    async init(location: unknown) {
      this.initLocation = location;
    },
    async next() {},
    async prev() {},
    async goToLocation(location: unknown) {
      this.cfis.push(location as string);
    },
    getCurrentCFI() {
      return this.cfis.at(-1) ?? null;
    },
    onRelocate(listener: (cfi: string) => void) {
      relocateListeners.push(listener);
      return () => {
        const index = relocateListeners.indexOf(listener);
        if (index >= 0) relocateListeners.splice(index, 1);
      };
    },
    onContentData(listener: (type: string, data: string) => string) {
      contentListeners.push(listener);
      return () => {
        const index = contentListeners.indexOf(listener);
        if (index >= 0) contentListeners.splice(index, 1);
      };
    },
    close() {
      this.closed = true;
    },
    emitRelocate(cfi: string) {
      for (const listener of relocateListeners) listener(cfi);
    },
    emitContentData(type: string, data: string) {
      for (const listener of contentListeners) {
        this.contentData.push({ type, data: listener(type, data) });
      }
    },
  };
  return host;
}

function createDocument(hostFactory: (container: HTMLElement) => FoliateViewHost) {
  return new EpubBookDocument({
    bytes: new Uint8Array([1, 2, 3]),
    metadata: { title: '示例书', author: '作者', language: 'zh' },
    viewHostFactory: hostFactory,
  });
}

describe('EpubBookDocument', () => {
  it('打开文档时挂载宿主并传入 EPUB 字节', async () => {
    const host = createFakeHost();
    const container = document.createElement('div');
    const book = new EpubBookDocument({
      bytes: new Uint8Array([1, 2, 3]),
      metadata: { title: '示例书', author: '作者', language: 'zh' },
      viewHostFactory: () => host,
    });

    await book.open(container);

    expect(host.openedBytes).toBeInstanceOf(File);
    expect(book.getLocation()).toBeNull();
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

  it('close 销毁宿主并清空状态', async () => {
    const host = createFakeHost();
    const book = createDocument(() => host);
    await book.open(document.createElement('div'));
    host.emitRelocate('epubcfi(/6/1)');

    book.close();

    expect(host.closed).toBe(true);
    expect(book.getLocation()).toBeNull();
  });

  it('清洗 XHTML 内容,移除脚本与危险链接', async () => {
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
  });

  it('关闭清洗开关时不注册内容清洗监听(仅测试用,生产默认开启)', async () => {
    const host = createFakeHost();
    const container = document.createElement('div');
    const book = new EpubBookDocument({
      bytes: new Uint8Array([1, 2, 3]),
      metadata: { title: '示例书', author: '作者', language: 'zh' },
      viewHostFactory: () => host,
      sanitize: false,
    });
    await book.open(container);

    host.emitContentData(
      'application/xhtml+xml',
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><script>alert(1)</script></body></html>`,
    );

    // 未开启清洗时没有内容处理监听器,内容原样透传(既不改写也不拦截)。
    expect(host.contentData).toHaveLength(0);
  });
});