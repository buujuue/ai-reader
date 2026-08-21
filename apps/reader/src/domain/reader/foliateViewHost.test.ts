import { describe, expect, it, vi } from 'vitest';

import { UpstreamFoliateViewHost } from './foliateViewHost';
import { openFoliateEpub } from './foliateEpubLoader';
import { sanitizeEpubContent } from './sanitizer';

vi.mock('./foliateEpubLoader', () => ({
  openFoliateEpub: vi.fn(),
}));

interface FakeViewElement {
  open: ReturnType<typeof vi.fn>;
  init: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  prev: ReturnType<typeof vi.fn>;
  goTo: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  clearSearch: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getCFI: ReturnType<typeof vi.fn>;
  resolveNavigation?: ReturnType<typeof vi.fn>;
  addAnnotation: ReturnType<typeof vi.fn>;
  lastLocation?: {
    cfi?: string;
    fraction?: number;
    section?: { current?: number; total?: number };
    location?: { current?: number; next?: number; total?: number };
    tocItem?: { label?: string };
    pageItem?: { label?: string };
  };
  book?: {
    transformTarget?: EventTarget;
    toc?: Array<{ label?: string; href?: string; subitems?: unknown }>;
    sections?: Array<{ id?: string; loadText?: () => Promise<string | null> }>;
  };
  renderer?: {
    getContents?: ReturnType<typeof vi.fn>;
    setAttribute?: ReturnType<typeof vi.fn>;
    setStyles?: ReturnType<typeof vi.fn>;
    index?: number;
  };
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function createFakeElement(): FakeViewElement {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    prev: vi.fn().mockResolvedValue(undefined),
    goTo: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
    clearSearch: vi.fn(),
    close: vi.fn(),
    getCFI: vi.fn().mockReturnValue('epubcfi(/6/1)!/4/2/2/1:0'),
    addAnnotation: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
  };
}

function createHost(element: FakeViewElement) {
  return new UpstreamFoliateViewHost(
    element as unknown as import('foliate-js/view.js').View & HTMLElement,
    Promise.resolve({} as typeof import('foliate-js/view.js')),
  );
}

describe('UpstreamFoliateViewHost 安全接线', () => {
  it('搜索使用规范转换后的章节文档,跨标签保留 CFI 并排除脚本文本', async () => {
    const element = createFakeElement();
    const book = {
      sections: [
        {
          id: 'chapter.xhtml',
          createDocument: vi.fn(async () =>
            new DOMParser().parseFromString(
              '<html><body><p>正<strong>文</strong><script>正文</script></p></body></html>',
              'text/html',
            ),
          ),
        },
      ],
    };
    const host = createHost(element);

    await host.open(book, {
      canonicalSearch: {
        sourceFingerprint: 'book-hash',
        canonicalTransformVersion: 'epub-canonical-v1',
        transform: (type, text) => sanitizeEpubContent(text),
      },
    });

    const events = [] as Array<import('./search').SearchEvent>;
    for await (const event of host.search({ query: '正文' })) events.push(event);

    expect(events.filter((event) => event.kind === 'match')).toHaveLength(1);
    expect(element.getCFI).toHaveBeenCalledOnce();
    expect(element.addAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.stringContaining('foliate-search:') }),
    );
  });

  it('正则搜索通过同一宿主返回明确的无效表达式状态', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({
      sections: [
        {
          createDocument: async () =>
            new DOMParser().parseFromString('<html><body>正文</body></html>', 'text/html'),
        },
      ],
    });

    let error: unknown;
    try {
      for await (const _event of host.search({ query: '(', mode: 'regex' })) {
        // exhaust the generator
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'INVALID_REGEX' });
  });

  it('旧版章节宿主不会绕过正则硬预算', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({ sections: [{ id: 'chapter.xhtml' }] });

    let error: unknown;
    try {
      for await (const _event of host.search({ query: '正文', mode: 'regex' })) {
        // exhaust the generator
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'REGEX_UNAVAILABLE' });
  });

  it('非核心资源失败时回退到清洗后的静态章节,不让整章空白', async () => {
    const element = createFakeElement();
    const transformTarget = new EventTarget();
    const section = {
      id: 'chapter.xhtml',
      load: vi.fn().mockRejectedValue(new Error('图片损坏')),
    };
    const loadText = vi.fn().mockResolvedValue(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><script>alert(1)</script><p>正文仍可读</p></body></html>',
    );
    const book = { sections: [section], loadText, transformTarget };
    const viewModule = { makeBook: vi.fn().mockResolvedValue(book) };
    const host = new UpstreamFoliateViewHost(
      element as unknown as import('foliate-js/view.js').View & HTMLElement,
      Promise.resolve(viewModule as unknown as typeof import('foliate-js/view.js')),
    );

    await host.open(new File(['epub'], 'book.epub'));
    const fallbackUrl = await section.load();

    expect(viewModule.makeBook).toHaveBeenCalledOnce();
    expect(element.open).toHaveBeenCalledWith(book);
    expect(fallbackUrl).toEqual(expect.any(String));
    expect(loadText).toHaveBeenCalledWith('chapter.xhtml');
  });

  it('原生 Book 在 renderer.open 阶段失败时重建纯 JS Book', async () => {
    const element = createFakeElement();
    element.open.mockRejectedValueOnce(new Error('原生 loader 不兼容'));
    const nativeBook = {};
    const pureJsBook = {};
    const viewModule = {
      makeBook: vi.fn().mockResolvedValue(pureJsBook),
    };
    vi.mocked(openFoliateEpub).mockResolvedValueOnce(nativeBook);
    const host = new UpstreamFoliateViewHost(
      element as unknown as import('foliate-js/view.js').View & HTMLElement,
      Promise.resolve(viewModule as unknown as typeof import('foliate-js/view.js')),
    );

    await host.open(new File(['epub'], 'book.epub'), {
      epubPrefetch: {
        parity: {
          protocolVersion: 1,
          semanticSource: 'foliate-js',
          platform: 'windows',
          validated: true,
          capabilities: [],
        },
        textCache: new Map(),
        sizes: new Map(),
      },
    });

    expect(viewModule.makeBook).toHaveBeenCalledOnce();
    expect(element.open).toHaveBeenNthCalledWith(1, nativeBook);
    expect(element.open).toHaveBeenNthCalledWith(2, pureJsBook);
  });

  it('打开文档后把内容清洗监听器接到 foliate 的 transformTarget(data 事件)', async () => {
    const element = createFakeElement();
    const transformTarget = new EventTarget();
    element.book = { transformTarget };
    const host = createHost(element);

    const listener = vi.fn((_type: string, data: string) => data);
    host.onContentData(listener);
    await host.open({});

    // 模拟 foliate Loader 派发 data 事件。
    const detail = { data: '<p>正文</p>', type: 'application/xhtml+xml' };
    transformTarget.dispatchEvent(new CustomEvent('data', { detail }));

    expect(listener).toHaveBeenCalledWith('application/xhtml+xml', '<p>正文</p>');
  });

  it('内容清洗器异常时丢弃资源,不会把原始内容回传给 renderer', async () => {
    const element = createFakeElement();
    const transformTarget = new EventTarget();
    element.book = { transformTarget };
    const host = createHost(element);
    host.onContentData(() => {
      throw new Error('清洗器故障');
    });
    await host.open({});

    const detail = { data: '<script>危险</script>', type: 'application/xhtml+xml' };
    transformTarget.dispatchEvent(new CustomEvent('data', { detail }));

    expect(detail.data).toBe('');
  });

  it('拦截外部链接,阻止阅读帧导航到远程资源', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    const externalHandler = element.addEventListener.mock.calls.find(
      ([type]) => type === 'external-link',
    )?.[1] as EventListener | undefined;
    expect(externalHandler).toBeDefined();

    const event = new Event('external-link', { cancelable: true });
    externalHandler?.(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('外部链接被转发给订阅者并以 preventDefault 阻止默认导航', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    const externalListener = vi.fn();
    host.onExternalLink(externalListener);
    await host.open({});

    const externalHandler = element.addEventListener.mock.calls.find(
      ([type]) => type === 'external-link',
    )?.[1] as EventListener | undefined;
    const event = new CustomEvent('external-link', {
      cancelable: true,
      detail: { href: 'https://example.com' },
    });
    externalHandler?.(event);

    expect(externalListener).toHaveBeenCalledWith('https://example.com');
    expect(event.defaultPrevented).toBe(true);
  });

  it('书内链接被转发给订阅者并阻止 foliate 默认导航', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    const internalListener = vi.fn();
    host.onInternalLink(internalListener);
    await host.open({});

    const linkHandler = element.addEventListener.mock.calls.find(
      ([type]) => type === 'link',
    )?.[1] as EventListener | undefined;
    expect(linkHandler).toBeDefined();
    const event = new CustomEvent('link', {
      cancelable: true,
      detail: { href: 'chapter2.xhtml' },
    });
    linkHandler?.(event);

    expect(internalListener).toHaveBeenCalledWith('chapter2.xhtml');
    expect(event.defaultPrevented).toBe(true);
  });

  it('goToHref 委托给 foliate goTo', async () => {
    const element = createFakeElement();
    element.book = { toc: [{ label: '第一章', href: 'c1.xhtml', subitems: null }] };
    const host = createHost(element);
    await host.open({});

    await host.goToHref('c1.xhtml');
    expect(element.goTo).toHaveBeenCalledWith('c1.xhtml');
  });

  it('getTOC 返回整理后的分层目录', async () => {
    const element = createFakeElement();
    element.book = {
      toc: [{ label: '第一章', href: 'c1.xhtml', subitems: null }],
    };
    const host = createHost(element);
    await host.open({});

    expect(host.getTOC()).toEqual([{ label: '第一章', href: 'c1.xhtml', subitems: null }]);
  });

  it('原生目录缺失时从可读章节标题生成本地推导目录且不改写原生 TOC', async () => {
    const element = createFakeElement();
    const nativeToc: Array<{ label?: string; href?: string; subitems?: unknown }> = [];
    const section = {
      id: 'chapter.xhtml',
      loadText: vi.fn().mockResolvedValue(
        '<html><body><h1 id="chapter">第一章</h1><h2 id="detail">细节</h2></body></html>',
      ),
    };
    element.book = { toc: nativeToc, sections: [section] };
    const host = createHost(element);

    await host.open(new File(['epub'], 'book.epub'), {
      derivedToc: { sourceFingerprint: 'derived-book-hash' },
    });

    expect(host.getTOCSource?.()).toBe('derived');
    expect(host.getTOC()).toEqual([
      {
        label: '第一章',
        href: 'chapter.xhtml#chapter',
        source: 'derived',
        subitems: [
          {
            label: '细节',
            href: 'chapter.xhtml#detail',
            source: 'derived',
            subitems: null,
          },
        ],
      },
    ]);
    expect(nativeToc).toEqual([]);
    expect(section.loadText).toHaveBeenCalledOnce();
  });

  it('已有可导航原生目录时不扫描章节正文', async () => {
    const element = createFakeElement();
    const section = {
      id: 'chapter.xhtml',
      loadText: vi.fn().mockResolvedValue('<h1>不应扫描</h1>'),
    };
    element.book = {
      toc: [{ label: '原生目录', href: 'chapter.xhtml', subitems: null }],
      sections: [section],
    };
    const host = createHost(element);

    await host.open(new File(['epub'], 'book.epub'), {
      derivedToc: { sourceFingerprint: 'native-book-hash' },
    });

    expect(host.getTOCSource?.()).toBe('native');
    expect(host.getTOC()).toEqual([{ label: '原生目录', href: 'chapter.xhtml', subitems: null }]);
    expect(section.loadText).not.toHaveBeenCalled();
  });

  it('原生目录只指向不存在的 spine 时改用可读章节标题推导', async () => {
    const element = createFakeElement();
    const section = {
      id: 'chapter.xhtml',
      loadText: vi.fn().mockResolvedValue('<h1 id="chapter">第一章</h1>'),
    };
    element.book = {
      toc: [{ label: '损坏目标', href: 'missing.xhtml', subitems: null }],
      sections: [section],
    };
    const host = createHost(element);

    await host.open(new File(['epub'], 'book.epub'), {
      derivedToc: { sourceFingerprint: 'invalid-native-book-hash' },
    });

    expect(host.getTOCSource?.()).toBe('derived');
    expect(host.getTOC()[0]?.href).toBe('chapter.xhtml#chapter');
    expect(section.loadText).toHaveBeenCalledOnce();
  });

  it('原生目录部分目标损坏时不丢弃剩余章节的推导导航', async () => {
    const element = createFakeElement();
    const section = {
      id: 'chapter.xhtml',
      loadText: vi.fn().mockResolvedValue('<h1 id="chapter">第一章</h1>'),
    };
    element.book = {
      toc: [
        { label: '可用章节', href: 'chapter.xhtml', subitems: null },
        { label: '损坏章节', href: 'missing.xhtml', subitems: null },
      ],
      sections: [section],
    };
    const host = createHost(element);

    await host.open(new File(['epub'], 'book.epub'), {
      derivedToc: { sourceFingerprint: 'partial-native-book-hash' },
    });

    expect(host.getTOCSource?.()).toBe('derived');
    expect(host.getTOC()[0]?.href).toBe('chapter.xhtml#chapter');
    expect(section.loadText).toHaveBeenCalledOnce();
  });

  it('章节尺寸超过标题扫描预算时不读取该章节', async () => {
    const element = createFakeElement();
    const section = {
      id: 'huge.xhtml',
      size: 512 * 1024 + 1,
      loadText: vi.fn().mockResolvedValue('<h1>不应读取</h1>'),
    };
    element.book = { toc: [], sections: [section] };
    const host = createHost(element);

    await host.open(new File(['epub'], 'book.epub'));

    expect(host.getTOC()).toEqual([]);
    expect(section.loadText).not.toHaveBeenCalled();
  });

  it('search 把 foliate 的原始产出归一化为领域事件', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    async function* upstream() {
      yield { progress: 0.5 };
      yield { label: '第一章', subitems: [{ cfi: 'epubcfi(/6/1)', excerpt: { pre: '前', match: '关键词', post: '后' } }] };
      yield { index: 1, subitems: [{ cfi: 'epubcfi(/6/2)', excerpt: { pre: 'a', match: 'b', post: 'c' } }] };
      yield 'done';
    }
    element.search.mockReturnValue(upstream());

    const events: Array<{ kind: string; progress?: number; cfi?: string }> = [];
    for await (const event of host.search({ query: '关键词' })) {
      events.push(
        event.kind === 'progress'
          ? { kind: 'progress', progress: event.progress }
          : { kind: 'match', cfi: event.match.cfi },
      );
    }

    expect(events).toEqual([
      { kind: 'progress', progress: 0.5 },
      { kind: 'match', cfi: 'epubcfi(/6/1)' },
      { kind: 'match', cfi: 'epubcfi(/6/2)' },
    ]);
  });

  it('search 把单节命中也归一化为 match 事件', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    async function* upstream() {
      yield { cfi: 'epubcfi(/6/5)', excerpt: { pre: 'x', match: 'y', post: 'z' } };
      yield 'done';
    }
    element.search.mockReturnValue(upstream());

    const events: Array<{ kind: string; cfi?: string }> = [];
    for await (const event of host.search({ query: 'y' })) {
      events.push(event.kind === 'match' ? { kind: 'match', cfi: event.match.cfi } : { kind: 'progress' });
    }
    expect(events).toEqual([{ kind: 'match', cfi: 'epubcfi(/6/5)' }]);
  });

  it('clearSearch 委托给 foliate 清除高亮', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    host.clearSearch();
    expect(element.clearSearch).toHaveBeenCalled();
  });

  it('close 释放渲染器并移除元素', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    host.close();

    expect(element.close).toHaveBeenCalled();
    expect(element.remove).toHaveBeenCalled();
  });

  it('getCFI 委托给 foliate 生成规范化 CFI', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    const result = host.getCFI(0, new Range());

    expect(element.getCFI).toHaveBeenCalledWith(0, expect.any(Range));
    expect(result).toBe('epubcfi(/6/1)!/4/2/2/1:0');
  });

  it('原 CFI 在当前已加载章节可解析时返回 true,不改变阅读位置', async () => {
    const element = createFakeElement();
    const anchor = vi.fn().mockReturnValue({});
    element.resolveNavigation = vi.fn().mockReturnValue({ index: 2, anchor });
    element.renderer = { getContents: vi.fn().mockReturnValue([{ index: 2, doc: {} }]) };
    const host = createHost(element);
    await host.open({});

    await expect(host.canResolveAnnotation('epubcfi(/6/2)!/4/2:0')).resolves.toBe(true);
    expect(element.goTo).not.toHaveBeenCalled();
    expect(anchor).toHaveBeenCalledWith({});
  });

  it('getCurrentIndex 从渲染器读取当前章节序号', async () => {
    const element = createFakeElement();
    element.renderer = { getContents: vi.fn().mockReturnValue([{ doc: {}, index: 3 }]) };
    const host = createHost(element);
    await host.open({});

    expect(host.getCurrentIndex()).toBe(3);
  });

  it('getCurrentIndex 在未就绪时返回 null', async () => {
    const element = createFakeElement();
    const host = createHost(element);

    expect(host.getCurrentIndex()).toBeNull();
  });

  it('固定版式渲染器没有 setStyles 时仍可打开并应用通用视口属性', async () => {
    const element = createFakeElement();
    const setAttribute = vi.fn();
    element.renderer = { setAttribute, getContents: vi.fn().mockReturnValue([]) };
    const host = createHost(element);

    await host.open({});
    expect(() => host.applyTypography({
      fontFamily: 'serif',
      fontSize: 18,
      lineHeight: 1.6,
      margin: 48,
      gap: 7,
      flow: 'paginated',
      theme: 'light',
    })).not.toThrow();
    expect(setAttribute).toHaveBeenCalledWith('flow', 'paginated');
  });

  it('从 foliate relocate 事件暴露章节、总进度和目录页标签', async () => {
    const element = createFakeElement();
    element.lastLocation = {
      cfi: 'epubcfi(/6/2)',
      fraction: 0.25,
      section: { current: 1, total: 4 },
      location: { current: 10, next: 11, total: 80 },
      tocItem: { label: '第二章' },
      pageItem: { label: '第 11 页' },
    };
    const host = createHost(element);
    await host.open({});

    expect(host.getReadingProgress()).toEqual({
      fraction: 0.25,
      section: { current: 1, total: 4 },
      location: { current: 10, next: 11, total: 80 },
      tocLabel: '第二章',
      pageLabel: '第 11 页',
    });

    const listener = vi.fn();
    host.onProgressChange(listener);
    const relocateHandler = element.addEventListener.mock.calls.find(
      ([type]) => type === 'relocate',
    )?.[1] as EventListener | undefined;
    relocateHandler?.(new CustomEvent('relocate', { detail: element.lastLocation }));
    expect(listener).toHaveBeenCalledWith({
      fraction: 0.25,
      section: { current: 1, total: 4 },
      location: { current: 10, next: 11, total: 80 },
      tocLabel: '第二章',
      pageLabel: '第 11 页',
    });
  });

  it('固定版式渲染器没有内容 index 时使用当前 spread 的章节序号', async () => {
    const element = createFakeElement();
    element.renderer = { index: 3, getContents: vi.fn().mockReturnValue([{}]) };
    const host = createHost(element);
    await host.open({});

    expect(host.getCurrentIndex()).toBe(3);
  });

  it('addAnnotation 委托给 foliate 绘制高亮', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    host.addAnnotation({ value: 'epubcfi(/6/1)', color: '#ffd54f' });

    expect(element.addAnnotation).toHaveBeenCalledWith({ value: 'epubcfi(/6/1)', color: '#ffd54f' });
  });

  it('removeAnnotation 以 remove=true 委托给 foliate 移除覆盖层', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    host.removeAnnotation('epubcfi(/6/1)');

    expect(element.addAnnotation).toHaveBeenCalledWith({ value: 'epubcfi(/6/1)' }, true);
  });

  it('对高亮覆盖层的点击经 show-annotation 事件转发给订阅者', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    const listener = vi.fn();
    host.onShowAnnotation(listener);
    await host.open({});

    const showHandler = element.addEventListener.mock.calls.find(
      ([type]) => type === 'show-annotation',
    )?.[1] as EventListener | undefined;
    expect(showHandler).toBeDefined();
    showHandler?.(new CustomEvent('show-annotation', { detail: { value: 'epubcfi(/6/1)' } }));

    expect(listener).toHaveBeenCalledWith('epubcfi(/6/1)');
  });
});
