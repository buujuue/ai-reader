import type { SearchEvent, SearchOptions } from './search';
import type { ReadingTypography } from './typography';
import { buildTypographyCss } from './typography';
import type { FoliateViewHost, FoliateViewHostFactory } from './viewHost';
import type { FoliateViewOpenOptions } from './viewHost';

/** 高亮覆盖层绘制函数(foliate-js Overlayer)。 */
import { Overlayer } from 'foliate-js/overlayer.js';

import { sanitizeEpubContent } from './sanitizer';
import { openFoliateEpub } from './foliateEpubLoader';

export type { FoliateViewHostFactory } from './viewHost';

/**
 * 创建 Foliate 视图宿主的窄缝。生产实现懒加载 foliate-js 的 `foliate-view`
 * 自定义元素;测试环境注入伪宿主。所有对具体渲染器的直接调用都集中在本模块。
 */
export const createFoliateViewHostFactory = (): FoliateViewHostFactory => {
  let viewModule: Promise<typeof import('foliate-js/view.js')> | null = null;

  return (container: HTMLElement) => {
    if (!viewModule) {
      viewModule = import('foliate-js/view.js');
    }
    const element = document.createElement('foliate-view') as unknown as ExtendedFoliateView;
    // foliate-view 自定义元素本身没有尺寸样式,默认 display:inline 会令内部
    // paginator 的 height:100% 失效,导致整本书空白。这里显式铺满容器。
    element.style.display = 'block';
    element.style.width = '100%';
    element.style.height = '100%';
    element.style.overflow = 'hidden';
    container.appendChild(element);
    return new UpstreamFoliateViewHost(element, viewModule);
  };
};

/** `foliate-view` 自定义元素:在原生 HTMLElement 之上叠加 View 的能力。 */
interface ExtendedFoliateView extends HTMLElement {
  open(book: unknown): Promise<void>;
  init(options: { lastLocation?: unknown } | { showTextStart?: boolean }): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  goTo(target: unknown): Promise<unknown>;
  resolveNavigation?(target: unknown): {
    index?: number;
    anchor?: (doc: Document) => unknown;
  } | undefined;
  search(opts: SearchOptions): AsyncGenerator<unknown, void, unknown>;
  clearSearch(): void;
  close(): void;
  getCFI(index: number, range: Range): string;
  addAnnotation(annotation: { value: string; color?: string }, remove?: boolean): unknown;
  lastLocation?: { cfi?: string };
  book?: {
    transformTarget?: EventTarget;
    toc?: Array<{ label?: string; href?: string; subitems?: unknown }>;
  };
  /** foliate-view 打开后创建的 `foliate-paginator` 渲染器。 */
  renderer?: ExtendedRenderer;
}

/** `foliate-paginator` 渲染器的窄描述:排版通过 attribute 与 setStyles 应用。 */
interface ExtendedRenderer {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  setStyles(styles: string): void;
  /** 读取当前已排布的内容文档。 */
  getContents?(): Array<{ doc?: Document; index?: number }>;
}

interface FoliateSection {
  id?: string;
  load: () => Promise<unknown>;
  loadText?: () => Promise<string | null>;
}

interface FoliateBook {
  sections?: FoliateSection[];
  loadText?: (href: string) => Promise<string | null>;
  transformTarget?: EventTarget;
}

/** foliate 目录节点到项目 TocItem 的映射。 */
interface FoliateTocNode {
  label?: string;
  href?: string;
  subitems?: FoliateTocNode[];
}

/** foliate search 产出的原始结果(归一化前的形状)。 */
interface FoliateSearchYield {
  progress?: number;
  subitems?: Array<{ cfi?: string; excerpt?: import('./search').SearchExcerpt }>;
  cfi?: string;
  excerpt?: import('./search').SearchExcerpt;
}

function emptyExcerpt(): import('./search').SearchExcerpt {
  return { pre: '', match: '', post: '' };
}

function toToc(items: unknown): import('./toc').Toc {
  const source = Array.isArray(items) ? (items as FoliateTocNode[]) : [];
  return source.map((item) => ({
    label: item.label ?? '',
    href: item.href ?? '',
    subitems: Array.isArray(item.subitems) ? toToc(item.subitems) : null,
  }));
}

/**
 * 包一层自定义元素(`foliate-view`)的宿主。只暴露 BookDocument 需要的窄方法,
 * 不把 foliate-js 的完整对象泄漏给上层。
 *
 * 安全接线(ADR-0010):
 * - 内容清洗:foliate 的 Loader 在 `book.transformTarget` 上派发 `data` 事件,
 *   宿主在此改写 XHTML 内容,移除脚本/iframe/object/embed/危险 URL。
 * - 外部链接:监听 `external-link` 事件并取消默认行为,阻止阅读帧导航到远程资源。
 * - 脚本:foliate-js 内置 `Loader.allowScript = false`,不起书籍脚本。
 */
export class UpstreamFoliateViewHost implements FoliateViewHost {
  private readonly element: ExtendedFoliateView;
  private readonly viewModule: Promise<typeof import('foliate-js/view.js')>;
  private opened = false;
  private readonly fallbackUrls = new Set<string>();
  private contentListeners = new Set<(type: string, data: string) => string>();
  private internalLinkListeners = new Set<(href: string) => void>();
  private externalLinkListeners = new Set<(href: string) => void>();
  private showAnnotationListeners = new Set<(value: string) => void>();

  constructor(
    element: ExtendedFoliateView,
    viewModule: Promise<typeof import('foliate-js/view.js')>,
  ) {
    this.element = element;
    this.viewModule = viewModule;
  }

  async open(book: unknown, options: FoliateViewOpenOptions = {}): Promise<void> {
    const viewModule = await this.viewModule;
    const isFileInput =
      typeof book === 'string' ||
      (typeof book === 'object' &&
        book !== null &&
        typeof (book as { arrayBuffer?: unknown }).arrayBuffer === 'function');
    let openedBook = book;
    let usedPrefetch = false;
    if (isFileInput && options.epubPrefetch) {
      try {
        // 原生结果只作为 foliate-js loader 的机械缓存。若构造失败，整条
        // 预取路径作废并重新从原始 File 走 foliate-js 的纯 JS loader。
        openedBook = await openFoliateEpub(book as File, options.epubPrefetch);
        usedPrefetch = true;
      } catch (error) {
        console.warn('EPUB 原生预取桥接失败,已回退到纯 JavaScript', error);
      }
    }
    const makePureBook = async (): Promise<unknown> => {
      if (typeof viewModule.makeBook === 'function' && isFileInput) {
        return viewModule.makeBook(book as string | File);
      }
      return book;
    };
    if (openedBook === book) {
      openedBook = await makePureBook();
    }
    const prepareBook = (candidate: unknown): void => {
      const foliateBook = asFoliateBook(candidate);
      if (foliateBook) {
        installSectionFallbacks(foliateBook, this.fallbackUrls);
      }
      // 先接入 Loader 的 data 事件,再让 foliate-view 创建 renderer,确保首章
      // 和后续章节都只能以清洗后的字符串进入 iframe。
      this.wireContentSanitization(foliateBook);
    };
    prepareBook(openedBook);
    try {
      await this.element.open(openedBook);
    } catch (error) {
      this.clearContentSanitization();
      this.revokeFallbackUrls();
      if (!usedPrefetch) {
        throw error;
      }
      // 原生 EPUB 对象可能在 renderer.open 阶段才暴露兼容性问题；清掉
      // 已经开始的尝试，再用同一个 File 构造纯 JS Book，避免半原生状态。
      try {
        this.element.close?.();
      } catch {
        // foliate-view 可能没有完成 open，close 失败不应阻止纯 JS 回退。
      }
      try {
        openedBook = await makePureBook();
        prepareBook(openedBook);
        await this.element.open(openedBook);
      } catch (fallbackError) {
        this.clearContentSanitization();
        this.revokeFallbackUrls();
        throw fallbackError;
      }
    }
    this.opened = true;
    this.wireInternalLinkHandling();
    this.wireExternalLinkBlocking();
    this.wireAnnotationDrawing();
    this.wireShowAnnotation();
  }

  async init(location: unknown): Promise<void> {
    await this.element.init(
      location ? { lastLocation: location } : { showTextStart: true },
    );
  }

  async next(): Promise<void> {
    await this.element.next();
  }

  async prev(): Promise<void> {
    await this.element.prev();
  }

  async goToLocation(location: unknown): Promise<void> {
    await this.element.goTo(location);
  }

  async goToHref(href: string): Promise<void> {
    await this.element.goTo(href);
  }

  getTOC(): import('./toc').Toc {
    return toToc(this.element.book?.toc);
  }

  getCurrentCFI(): string | null {
    if (!this.opened) {
      return null;
    }
    return this.element.lastLocation?.cfi ?? null;
  }

  applyTypography(settings: ReadingTypography): void {
    const renderer = this.element.renderer;
    if (!renderer) {
      return;
    }
    // 分页/滚动、分栏间距、页边距与最大画布尺寸经渲染器 attribute 应用。
    renderer.setAttribute('flow', settings.flow);
    renderer.setAttribute('gap', `${settings.gap}%`);
    renderer.setAttribute('margin', `${settings.margin}px`);
    renderer.setAttribute('max-inline-size', '720px');
    renderer.setAttribute('max-block-size', '1440px');
    renderer.setAttribute('max-column-count', '2');
    // 字体、字号、行距与主题经 setStyles 注入文档 CSS。
    renderer.setStyles(buildTypographyCss(settings));
  }

  async *search(options: SearchOptions): AsyncGenerator<SearchEvent, void, void> {
    const generator = this.element.search(options);
    for await (const raw of generator) {
      // foliate 的 search 逐节产出 {progress} 或 {label, subitems},单节搜索产出
      // {cfi, excerpt},最后以字符串 'done' 结束。这里统一归一化为领域事件。
      if (typeof raw === 'string') {
        continue;
      }
      const result = raw as FoliateSearchYield;
      if (typeof result.progress === 'number') {
        yield { kind: 'progress', progress: result.progress };
      } else if (Array.isArray(result.subitems)) {
        for (const item of result.subitems) {
          if (item.cfi) {
            yield { kind: 'match', match: { cfi: item.cfi, excerpt: item.excerpt ?? emptyExcerpt() } };
          }
        }
      } else if (result.cfi) {
        yield {
          kind: 'match',
          match: { cfi: result.cfi, excerpt: result.excerpt ?? emptyExcerpt() },
        };
      }
    }
  }

  clearSearch(): void {
    this.element.clearSearch?.();
  }

  onRelocate(listener: (cfi: string) => void): () => void {
    const handler: EventListener = (event) => {
      const detail = (event as CustomEvent<{ cfi?: string }>).detail;
      if (detail?.cfi) {
        listener(detail.cfi);
      }
    };
    this.element.addEventListener('relocate', handler);
    return () => this.element.removeEventListener('relocate', handler);
  }

  onInternalLink(listener: (href: string) => void): () => void {
    this.internalLinkListeners.add(listener);
    return () => this.internalLinkListeners.delete(listener);
  }

  onExternalLink(listener: (href: string) => void): () => void {
    this.externalLinkListeners.add(listener);
    return () => this.externalLinkListeners.delete(listener);
  }

  onContentData(listener: (type: string, data: string) => string): () => void {
    this.contentListeners.add(listener);
    return () => this.contentListeners.delete(listener);
  }

  getContentDocs(): readonly Document[] {
    const contents = this.element.renderer?.getContents?.() ?? [];
    return contents
      .map((content: { doc?: Document }) => content.doc)
      .filter((doc: Document | undefined): doc is Document => !!doc);
  }

  onContentCreate(listener: (doc: Document) => void): () => void {
    const handler: EventListener = (event) => {
      const detail = (event as CustomEvent<{ doc?: Document }>).detail;
      if (detail?.doc) {
        listener(detail.doc);
      }
    };
    // foliate-view 在每次内容文档加载后派发 `load` 事件(随章节翻页持续出现)。
    this.element.addEventListener('load', handler);
    return () => this.element.removeEventListener('load', handler);
  }

  getCFI(index: number, range: Range): string {
    return this.element.getCFI(index, range);
  }

  async canResolveAnnotation(value: string): Promise<boolean> {
    try {
      const resolved = this.element.resolveNavigation?.(value);
      if (!resolved || typeof resolved.index !== 'number' || !resolved.anchor) {
        return false;
      }
      const content = this.element.renderer?.getContents?.().find(
        (candidate) => candidate.index === resolved.index && candidate.doc,
      );
      if (!content?.doc) {
        return false;
      }
      return resolved.anchor(content.doc) != null;
    } catch {
      return false;
    }
  }

  getCurrentIndex(): number | null {
    if (!this.opened) {
      return null;
    }
    const contents = this.element.renderer?.getContents?.() ?? [];
    const first = contents[0] as { index?: number } | undefined;
    return typeof first?.index === 'number' ? first.index : null;
  }

  addAnnotation(annotation: { value: string; color: string }): void {
    this.element.addAnnotation(annotation);
  }

  removeAnnotation(value: string): void {
    this.element.addAnnotation({ value }, true);
  }

  onShowAnnotation(listener: (value: string) => void): () => void {
    this.showAnnotationListeners.add(listener);
    return () => this.showAnnotationListeners.delete(listener);
  }

  close(): void {
    try {
      if (this.opened) {
        this.element.close?.();
      }
    } finally {
      this.contentCleanup?.();
      this.internalLinkCleanup?.();
      this.externalLinkCleanup?.();
      this.element.remove();
      this.contentListeners.clear();
      this.internalLinkListeners.clear();
      this.externalLinkListeners.clear();
      this.showAnnotationListeners.clear();
      this.drawAnnotationCleanup?.();
      this.showAnnotationCleanup?.();
      this.contentCleanup = null;
      this.internalLinkCleanup = null;
      this.externalLinkCleanup = null;
      this.drawAnnotationCleanup = null;
      this.showAnnotationCleanup = null;
      this.revokeFallbackUrls();
      this.opened = false;
    }
  }

  private revokeFallbackUrls(): void {
    for (const url of this.fallbackUrls) {
      URL.revokeObjectURL(url);
    }
    this.fallbackUrls.clear();
  }

  private clearContentSanitization(): void {
    this.contentCleanup?.();
    this.contentCleanup = null;
  }

  /** 在 foliate Loader 派发 `data` 事件时对不可信内容做清洗。 */
  private wireContentSanitization(book: FoliateBook | null): void {
    const target = book?.transformTarget ?? this.element.book?.transformTarget;
    if (!target) {
      return;
    }
    const handler: EventListener = (event) => {
      const detail = (event as CustomEvent<{ data?: string; type?: string }>).detail;
      if (typeof detail?.data !== 'string' || typeof detail?.type !== 'string') {
        return;
      }
      for (const listener of this.contentListeners) {
        try {
          const transformed = listener(detail.type, detail.data);
          detail.data = typeof transformed === 'string' ? transformed : '';
        } catch (error) {
          // 清洗异常必须失效关闭,不能把原始主动内容继续交给 renderer。
          console.warn('EPUB 内容清洗失败,已丢弃该资源', error);
          detail.data = '';
        }
      }
    };
    target.addEventListener('data', handler);
    this.contentCleanup = () => target.removeEventListener('data', handler);
  }

  /**
   * 书内链接:阻止 foliate 默认导航(它会把 href 压进自己的历史),把 href
   * 面向上层,由上层统一导航并送给本项目的历史。
   */
  private wireInternalLinkHandling(): void {
    const handler: EventListener = (event) => {
      event.preventDefault();
      const href = (event as CustomEvent<{ href?: string }>).detail?.href;
      if (typeof href === 'string') {
        for (const listener of this.internalLinkListeners) {
          listener(href);
        }
      }
    };
    this.element.addEventListener('link', handler);
    this.internalLinkCleanup = () => this.element.removeEventListener('link', handler);
  }

  /** 阻止外部链接在阅读帧内导航,把目标 URL 面向上层,由上层交给系统浏览器。 */
  private wireExternalLinkBlocking(): void {
    const handler: EventListener = (event) => {
      event.preventDefault();
      const href = (event as CustomEvent<{ href?: string }>).detail?.href;
      if (typeof href === 'string') {
        for (const listener of this.externalLinkListeners) {
          listener(href);
        }
      }
    };
    this.element.addEventListener('external-link', handler);
    this.externalLinkCleanup = () =>
      this.element.removeEventListener('external-link', handler);
  }

  private contentCleanup: (() => void) | null = null;
  private internalLinkCleanup: (() => void) | null = null;
  private externalLinkCleanup: (() => void) | null = null;
  private drawAnnotationCleanup: (() => void) | null = null;
  private showAnnotationCleanup: (() => void) | null = null;

  /**
   * 高亮绘制接线:foliate 在 `addAnnotation` 解析导航后派发 `draw-annotation` 事件,
   * 携带 `draw`(把某绘制函数应用到覆盖层)与 `annotation`。这里用 Overlayer.highlight
   * 把批注绘制成半透明高亮覆盖层,颜色取自传入批注。
   */
  private wireAnnotationDrawing(): void {
    const handler: EventListener = (event) => {
      const detail = (event as CustomEvent<{
        draw?: (style: unknown, options?: unknown) => void;
        annotation?: { value?: string; color?: string };
      }>).detail;
      const draw = detail?.draw;
      const color = detail?.annotation?.color;
      if (typeof draw !== 'function') {
        return;
      }
      draw(Overlayer.highlight, { color: color ?? '#ffd54f' });
    };
    this.element.addEventListener('draw-annotation', handler);
    this.drawAnnotationCleanup = () =>
      this.element.removeEventListener('draw-annotation', handler);
  }

  /** 对高亮覆盖层的点击派发 `show-annotation` 事件,把被点击批注的 CFI 转发给订阅者。 */
  private wireShowAnnotation(): void {
    const handler: EventListener = (event) => {
      const detail = (event as CustomEvent<{ value?: string }>).detail;
      if (typeof detail?.value !== 'string') {
        return;
      }
      for (const listener of this.showAnnotationListeners) {
        listener(detail.value);
      }
    };
    this.element.addEventListener('show-annotation', handler);
    this.showAnnotationCleanup = () =>
      this.element.removeEventListener('show-annotation', handler);
  }
}

function asFoliateBook(value: unknown): FoliateBook | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as FoliateBook;
}

/**
 * Foliate 的默认 Loader 在包内图片/字体损坏时会让整段 XHTML load reject。
 * 非核心资源失败时回退到只含已清洗静态内容的章节 URL,保住正文阅读；
 * 若章节文本本身也不可读,继续抛出原错误,由上层按整章失败展示。
 */
function installSectionFallbacks(book: FoliateBook, fallbackUrls: Set<string>): void {
  for (const section of book.sections ?? []) {
    const sectionId = section.id;
    const loadText = section.loadText
      ? section.loadText.bind(section)
      : sectionId && book.loadText
        ? () => book.loadText?.(sectionId) ?? Promise.resolve(null)
        : null;
    if (typeof section.load !== 'function' || !loadText) {
      continue;
    }
    const originalLoad = section.load;
    let fallbackUrl: string | null = null;
    section.load = async () => {
      try {
        return await originalLoad.call(section);
      } catch (error) {
        if (fallbackUrl) {
          return fallbackUrl;
        }
        let source: string | null;
        try {
          source = await loadText();
        } catch {
          throw error;
        }
        if (typeof source !== 'string') {
          throw error;
        }
        const safeSource = sanitizeEpubContent(source);
        if (typeof URL.createObjectURL !== 'function') {
          throw error;
        }
        fallbackUrl = URL.createObjectURL(
          new Blob([safeSource], { type: 'application/xhtml+xml' }),
        );
        fallbackUrls.add(fallbackUrl);
        console.warn('EPUB 非核心资源加载失败,已降级为静态章节', error);
        return fallbackUrl;
      }
    };
  }
}
