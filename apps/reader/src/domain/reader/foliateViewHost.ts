import type { SearchEvent, SearchOptions } from './search';
import type { ReadingTypography } from './typography';
import {
  buildReflowableEpubTypographyCss,
  buildTypographyCss,
  DEFAULT_READING_TYPOGRAPHY,
} from './typography';
import {
  REFLOWABLE_READER_THEME_PALETTES,
  type ReflowableReaderThemeId,
} from './epubTheme';
import type { FoliateViewHost, FoliateViewHostFactory } from './viewHost';
import type { FoliateViewOpenOptions } from './viewHost';
import type { ReadingProgress } from './readingProgress';
import { normalizeReadingProgress } from './readingProgress';

/** 高亮覆盖层绘制函数(foliate-js Overlayer)。 */
import { Overlayer } from 'foliate-js/overlayer.js';

import { sanitizeEpubContent } from './sanitizer';
import { removeEpubDisplayOnlyNodes } from './epubCanonical';
import { openFoliateEpub } from './foliateEpubLoader';
import { degradeUnsupportedMathMl } from './mathmlFallback';
import {
  DEFAULT_DERIVED_TOC_BUDGET,
  deriveEpubToc,
  isUsableToc,
} from './derivedToc';
import type { TocSource } from './toc';
import {
  addCanonicalSearchSection,
  buildCanonicalSearchIndexKey,
  createCanonicalSectionText,
  createCanonicalSearchMatch,
  findRegexMatchOffsetsInWorker,
  findCanonicalSectionMatches,
  isUsableCanonicalSearchIndex,
  MAX_REGEX_RESULTS,
  type CanonicalSearchIndexSnapshot,
  type SearchBudgetState,
} from './canonicalSearch';
import { SearchBudgetError } from './canonicalSearch';

const SEARCH_ANNOTATION_PREFIX = 'foliate-search:';

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
  };
  /** foliate-view 打开后创建的 `foliate-paginator` 渲染器。 */
  renderer?: ExtendedRenderer;
}

/** `foliate-paginator` 渲染器的窄描述:排版通过 attribute 与 setStyles 应用。 */
interface ExtendedRenderer {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  setStyles?(styles: string): void;
  /** 读取当前已排布的内容文档。 */
  getContents?(): Array<{ doc?: Document; index?: number }>;
  /** 固定版式渲染器提供当前 spread 对应的章节序号。 */
  index?: number;
}

interface FoliateSection {
  id?: string;
  /** foliate 解析出的包内资源尺寸;用于在读取正文前执行扫描预算预检。 */
  size?: number;
  load: () => Promise<unknown>;
  loadText?: () => Promise<string | null>;
  createDocument?: () => Promise<Document>;
}

interface FoliateBook {
  sections?: FoliateSection[];
  loadText?: (href: string) => Promise<string | null>;
  toc?: Array<{ label?: string; href?: string; subitems?: unknown }>;
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

function readRelocateDetail(event: Event): ExtendedFoliateView['lastLocation'] | null {
  const detail = (event as CustomEvent<unknown>).detail;
  return detail && typeof detail === 'object'
    ? detail as ExtendedFoliateView['lastLocation']
    : null;
}

function toToc(items: unknown): import('./toc').Toc {
  const source = Array.isArray(items) ? (items as FoliateTocNode[]) : [];
  return source.map((item) => {
    const candidate = item && typeof item === 'object' ? item : {};
    return {
      label: typeof candidate.label === 'string' ? candidate.label : '',
      href: typeof candidate.href === 'string' ? candidate.href : '',
      subitems: Array.isArray(candidate.subitems) ? toToc(candidate.subitems) : null,
    };
  });
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
  private element: ExtendedFoliateView;
  private readonly viewModule: Promise<typeof import('foliate-js/view.js')>;
  private opened = false;
  private readonly fallbackUrls = new Set<string>();
  private book: FoliateBook | null = null;
  private derivedToc: import('./toc').Toc | null = null;
  private tocSource: TocSource = 'native';
  private contentListeners = new Set<(type: string, data: string) => string>();
  private internalLinkListeners = new Set<(href: string) => void>();
  private externalLinkListeners = new Set<(href: string) => void>();
  private showAnnotationListeners = new Set<(value: string) => void>();
  private readErrorListeners = new Set<(error: unknown) => void>();
  private canonicalSearchConfig: FoliateViewOpenOptions['canonicalSearch'] | null = null;
  private canonicalSearchIndex: CanonicalSearchIndexSnapshot | null = null;
  private canonicalSearchIndexKey: string | null = null;
  private searchAnnotations = new Map<number, string[]>();
  private readonly relocateHandlers = new Set<EventListener>();
  private readonly progressHandlers = new Set<EventListener>();
  private readonly contentCreateHandlers = new Set<EventListener>();
  private closeScheduled = false;
  private activeReflowableTheme: ReflowableReaderThemeId | null = null;
  private currentTypography: ReadingTypography | null = null;

  constructor(
    element: ExtendedFoliateView,
    viewModule: Promise<typeof import('foliate-js/view.js')>,
  ) {
    this.element = element;
    this.viewModule = viewModule;
  }

  async open(book: unknown, options: FoliateViewOpenOptions = {}): Promise<void> {
    this.canonicalSearchConfig = options.canonicalSearch ?? null;
    const viewModule = await this.viewModule;
    this.ensureElementUpgraded();
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
      if (typeof book === 'string' && typeof viewModule.makeBook === 'function') {
        return viewModule.makeBook(book);
      }
      if (isFileInput) {
        // 始终使用项目自己的惰性 ZIP loader；否则 foliate-js.makeBook 会
        // 重新创建 zip.js BlobReader，绕过同条目并发去重与 Source 边界。
        return openFoliateEpub(book as File, null);
      }
      return book;
    };
    if (openedBook === book) {
      openedBook = await makePureBook();
    }
    const prepareBook = (candidate: unknown): void => {
      const foliateBook = asFoliateBook(candidate);
      if (foliateBook) {
        installSectionFallbacks(foliateBook, this.fallbackUrls, (error) => {
          this.notifyReadError(error);
        });
        installCanonicalDocumentFactories(foliateBook, this.canonicalSearchConfig);
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
    this.book = asFoliateBook(this.element.book) ?? asFoliateBook(openedBook);
    await this.deriveTocWhenNeeded(this.book, options.derivedToc);
    this.wireInternalLinkHandling();
    this.wireExternalLinkBlocking();
    this.wireAnnotationDrawing();
    this.wireShowAnnotation();
  }

  /**
   * 工厂为了保持同步接口会先创建占位元素，再懒加载 foliate-js。某些 WebView
   * 不会把模块稍后注册的自定义元素升级到既有节点，因此在 open 前补一次安全替换。
   */
  private ensureElementUpgraded(): void {
    if (typeof this.element.open === 'function') return;
    const previous = this.element;
    const upgraded = document.createElement('foliate-view') as unknown as ExtendedFoliateView;
    upgraded.style.display = 'block';
    upgraded.style.width = '100%';
    upgraded.style.height = '100%';
    upgraded.style.overflow = 'hidden';
    previous.replaceWith(upgraded);
    this.element = upgraded;
    for (const handler of this.relocateHandlers) upgraded.addEventListener('relocate', handler);
    for (const handler of this.progressHandlers) upgraded.addEventListener('relocate', handler);
    for (const handler of this.contentCreateHandlers) upgraded.addEventListener('load', handler);
  }

  attach(container: HTMLElement): void {
    if (this.element.parentElement !== container) {
      container.appendChild(this.element);
    }
  }

  detach(): void {
    // 保持 renderer 连在一个固定、不可见的缓存根上。直接 remove() 会让
    // foliate-paginator 尚未结束的 rAF 在下一帧读取空 docBackground，尤其在
    // Chromium/WebView 切标签时会产生异步异常；缓存命中时仍只移动这一节点。
    const cacheRoot = getRuntimeCacheRoot();
    cacheRoot.appendChild(this.element);
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
    this.drawSearchAnnotations();
  }

  async goToHref(href: string): Promise<void> {
    await this.element.goTo(href);
    this.drawSearchAnnotations();
  }

  getTOC(): import('./toc').Toc {
    if (this.derivedToc !== null) {
      return this.derivedToc;
    }
    return toToc(this.book?.toc ?? this.element.book?.toc);
  }

  getTOCSource(): TocSource {
    return this.tocSource;
  }

  getCurrentCFI(): string | null {
    if (!this.opened) {
      return null;
    }
    return this.element.lastLocation?.cfi ?? null;
  }

  getReadingProgress(): ReadingProgress | null {
    return normalizeReadingProgress(this.element.lastLocation);
  }

  onProgressChange(listener: (progress: ReadingProgress) => void): () => void {
    const handler: EventListener = (event) => {
      const progress = normalizeReadingProgress(readRelocateDetail(event));
      if (progress) listener(progress);
    };
    this.element.addEventListener('relocate', handler);
    this.progressHandlers.add(handler);
    return () => {
      this.progressHandlers.delete(handler);
      this.element.removeEventListener('relocate', handler);
    };
  }

  isReflowable(): boolean {
    return typeof this.element.renderer?.setStyles === 'function';
  }

  applyTypography(settings: ReadingTypography): void {
    this.currentTypography = settings;
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
    // `foliate-paginator` exposes setStyles; `foliate-fxl` is an HTMLElement
    // and intentionally keeps the book's viewport/style instead of reflowing it.
    if (this.activeReflowableTheme && this.isReflowable()) {
      renderer.setStyles?.(
        buildReflowableEpubTypographyCss(settings, this.activeReflowableTheme),
      );
      this.applyReflowableThemeBackground(this.activeReflowableTheme);
    } else {
      this.activeReflowableTheme = null;
      // `foliate-fxl` 没有 setStyles;固定版式只继续消费既有视口属性,
      // 不把全局工作台正文主题扩展到整页图片或 PDF。
      renderer.setStyles?.(buildTypographyCss(settings));
    }
  }

  applyReflowableTheme(theme: ReflowableReaderThemeId): void {
    if (!this.isReflowable()) return;
    this.activeReflowableTheme = theme;
    this.applyTypography(this.currentTypography ?? DEFAULT_READING_TYPOGRAPHY);
  }

  async *search(options: SearchOptions): AsyncGenerator<SearchEvent, void, void> {
    if (this.canSearchCanonicalSections()) {
      yield* this.searchCanonicalSections(options);
      return;
    }

    // 注入伪宿主或旧版渲染器没有 createDocument 时保留窄接口兼容路径。
    if (options.mode === 'regex') {
      throw new SearchBudgetError(
        'REGEX_UNAVAILABLE',
        '当前阅读材料不支持带硬预算的正则搜索',
      );
    }
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
    for (const cfis of this.searchAnnotations.values()) {
      for (const cfi of cfis) {
        this.element.addAnnotation({ value: SEARCH_ANNOTATION_PREFIX + cfi }, true);
      }
    }
    this.searchAnnotations.clear();
    this.element.clearSearch?.();
  }

  onRelocate(listener: (cfi: string) => void): () => void {
    const handler: EventListener = (event) => {
      const detail = readRelocateDetail(event);
      if (detail?.cfi) {
        listener(detail.cfi);
      }
    };
    this.element.addEventListener('relocate', handler);
    this.relocateHandlers.add(handler);
    return () => {
      this.relocateHandlers.delete(handler);
      this.element.removeEventListener('relocate', handler);
    };
  }

  onReadError(listener: (error: unknown) => void): () => void {
    this.readErrorListeners.add(listener);
    return () => this.readErrorListeners.delete(listener);
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
      .filter((doc: Document | undefined): doc is Document => !!doc)
      .map((doc) => {
        degradeUnsupportedMathMl(doc);
        return doc;
      });
  }

  onContentCreate(listener: (doc: Document) => void): () => void {
    const handler: EventListener = (event) => {
      const detail = (event as CustomEvent<{ doc?: Document }>).detail;
      if (detail?.doc) {
        degradeUnsupportedMathMl(detail.doc);
        if (this.activeReflowableTheme) {
          this.applyReflowableThemeBackgroundToDocument(detail.doc, this.activeReflowableTheme);
        }
        listener(detail.doc);
        this.drawSearchAnnotationsForDocument(detail.doc);
      }
    };
    // foliate-view 在每次内容文档加载后派发 `load` 事件(随章节翻页持续出现)。
    this.element.addEventListener('load', handler);
    this.contentCreateHandlers.add(handler);
    return () => {
      this.contentCreateHandlers.delete(handler);
      this.element.removeEventListener('load', handler);
    };
  }

  /**
   * Paginator 会缓存章节首次计算出的背景。为保留书内 body 背景/背景图片，
   * 透明正文才使用全局纸张色；带有书内背景的章节把变量置空，让 paginator
   * 保留原始背景。新章节由同一个 load 事件路径再次执行，避免迟到章节闪回旧色。
   */
  private applyReflowableThemeBackground(theme: ReflowableReaderThemeId): void {
    const background = REFLOWABLE_READER_THEME_PALETTES[theme].background;
    for (const doc of this.getContentDocs()) {
      this.applyReflowableThemeBackgroundToDocument(doc, theme);
    }
  }

  private applyReflowableThemeBackgroundToDocument(
    doc: Document,
    theme: ReflowableReaderThemeId,
  ): void {
    const root = doc.documentElement;
    const body = doc.body;
    if (!root || !body || !doc.defaultView) return;
    const bodyStyle = doc.defaultView.getComputedStyle(body);
    const hasBookBackground =
      bodyStyle.backgroundImage !== 'none' ||
      (bodyStyle.backgroundColor !== '' &&
        bodyStyle.backgroundColor !== 'transparent' &&
        bodyStyle.backgroundColor !== 'rgba(0, 0, 0, 0)');
    root.style.setProperty(
      '--theme-bg-color',
      hasBookBackground ? '' : REFLOWABLE_READER_THEME_PALETTES[theme].background,
    );
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
    if (typeof first?.index === 'number') return first.index;
    const rendererIndex = this.element.renderer?.index;
    return typeof rendererIndex === 'number' ? rendererIndex : null;
  }

  getContentDocumentIndex(document: Document): number | null {
    const content = this.element.renderer?.getContents?.().find(
      (candidate) => candidate.doc === document,
    );
    return typeof content?.index === 'number' ? content.index : null;
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
    if (this.closeScheduled) return;
    this.closeScheduled = true;
    const finalize = () => {
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
        this.readErrorListeners.clear();
        this.relocateHandlers.clear();
        this.progressHandlers.clear();
        this.contentCreateHandlers.clear();
        this.drawAnnotationCleanup?.();
        this.showAnnotationCleanup?.();
        this.contentCleanup = null;
        this.internalLinkCleanup = null;
        this.externalLinkCleanup = null;
        this.drawAnnotationCleanup = null;
        this.showAnnotationCleanup = null;
        this.revokeFallbackUrls();
        this.searchAnnotations.clear();
        this.canonicalSearchIndex = null;
        this.canonicalSearchIndexKey = null;
        this.canonicalSearchConfig = null;
        this.book = null;
        this.derivedToc = null;
        this.tocSource = 'native';
        this.activeReflowableTheme = null;
        this.currentTypography = null;
        this.opened = false;
      }
    };

    // paginator.js 在 setStyles() 中排队的 rAF 会读取当前页面背景；关闭一份
    // 已摘到缓存根的 renderer 前让这些帧先落地，避免销毁 Paginator 后旧帧
    // 访问已置空的内部 View。挂载在可见容器中的 Runtime 仍保持同步关闭。
    const detached = this.element.parentElement?.id === 'ai-reader-runtime-cache-root';
    if (detached && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(finalize));
    } else {
      finalize();
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

  private notifyReadError(error: unknown): void {
    for (const listener of this.readErrorListeners) {
      listener(error);
    }
  }

  private canSearchCanonicalSections(): boolean {
    return Boolean(
      this.book?.sections?.length &&
        this.book.sections.every((section) => typeof section.createDocument === 'function'),
    );
  }

  private async *searchCanonicalSections(
    options: SearchOptions,
  ): AsyncGenerator<SearchEvent, void, void> {
    const sections = this.book?.sections ?? [];
    this.clearSearch();
    const state: SearchBudgetState = { resultCount: 0 };
    const signal = options.signal;

    for (const [index, section] of sections.entries()) {
      if (signal?.aborted) {
        throw new SearchBudgetError('SEARCH_CANCELLED', '搜索已取消');
      }
      const doc = await section.createDocument!();
      if (signal?.aborted) {
        throw new SearchBudgetError('SEARCH_CANCELLED', '搜索已取消');
      }
      const text = createCanonicalSectionText(doc);
      this.updateCanonicalSearchIndex(index, text);
      const regexOffsets =
        options.mode === 'regex'
          ? await findRegexMatchOffsetsInWorker(text.text, options.query, options.matchCase ?? false, signal)
          : null;
      if (regexOffsets && state.resultCount + regexOffsets.length > MAX_REGEX_RESULTS) {
        throw new SearchBudgetError(
          'REGEX_RESULT_LIMIT',
          `正则搜索结果超过上限 ${MAX_REGEX_RESULTS} 条`,
        );
      }
      if (regexOffsets) state.resultCount += regexOffsets.length;
      const matches = regexOffsets
        ? regexOffsets.map(({ start, end }) => createCanonicalSearchMatch(text, start, end))
        : findCanonicalSectionMatches(text, options, state, {
            now: () => globalThis.performance?.now?.() ?? Date.now(),
          });
      for (const match of matches) {
        if (signal?.aborted) {
          throw new SearchBudgetError('SEARCH_CANCELLED', '搜索已取消');
        }
        const cfi = this.element.getCFI(index, match.range);
        const list = this.searchAnnotations.get(index) ?? [];
        list.push(cfi);
        this.searchAnnotations.set(index, list);
        this.element.addAnnotation({ value: SEARCH_ANNOTATION_PREFIX + cfi });
        yield { kind: 'match', match: { cfi, excerpt: match.excerpt } };
      }
      yield {
        kind: 'progress',
        progress: sections.length === 0 ? 1 : (index + 1) / sections.length,
      };
      // Yield between sections so a pending query can be cancelled before the
      // next chapter is loaded.
      await Promise.resolve();
    }
  }

  private updateCanonicalSearchIndex(
    sectionIndex: number,
    section: import('./canonicalSearch').CanonicalSectionText,
  ): void {
    const config = this.canonicalSearchConfig;
    if (!config) return;
    const key = buildCanonicalSearchIndexKey({
      sourceFingerprint: config.sourceFingerprint,
      canonicalTransformVersion: config.canonicalTransformVersion,
    });
    if (this.canonicalSearchIndexKey !== key) {
      const cached = config.cache?.get(key);
      this.canonicalSearchIndex = isUsableCanonicalSearchIndex(cached, key)
        ? cached
        : { key, sections: {}, totalCharacters: 0 };
      this.canonicalSearchIndexKey = key;
    }
    this.canonicalSearchIndex = addCanonicalSearchSection(
      this.canonicalSearchIndex ?? { key, sections: {}, totalCharacters: 0 },
      sectionIndex,
      section,
    );
    config.cache?.set(key, this.canonicalSearchIndex);
  }

  private drawSearchAnnotations(): void {
    for (const [index, cfis] of this.searchAnnotations) {
      if (this.element.renderer?.getContents?.().some((content) => content.index === index)) {
        this.drawSearchAnnotationsForIndex(cfis);
      }
    }
  }

  private drawSearchAnnotationsForDocument(doc: Document): void {
    const index = this.element.renderer?.getContents?.().find((content) => content.doc === doc)?.index;
    if (typeof index !== 'number') return;
    this.drawSearchAnnotationsForIndex(this.searchAnnotations.get(index) ?? []);
  }

  private drawSearchAnnotationsForIndex(cfis: readonly string[]): void {
    for (const cfi of cfis) {
      this.element.addAnnotation({ value: SEARCH_ANNOTATION_PREFIX + cfi });
    }
  }

  private async deriveTocWhenNeeded(
    book: FoliateBook | null,
    options: import('./viewHost').FoliateViewOpenOptions['derivedToc'],
  ): Promise<void> {
    if (!options) {
      this.tocSource = 'native';
      return;
    }
    const nativeToc = toToc(book?.toc);
    const spineHrefs = new Set(
      (book?.sections ?? [])
        .map((section) => section.id?.trim())
        .filter((href): href is string => Boolean(href)),
    );
    const nativeHrefIsNavigable = (href: string): boolean => {
      if (href.trim().length === 0) {
        return false;
      }
      if (spineHrefs.size === 0) {
        return true;
      }
      const path = href.split('#', 1)[0]?.trim() ?? '';
      return path.length > 0 && spineHrefs.has(path);
    };
    if (isUsableToc(nativeToc, nativeHrefIsNavigable)) {
      this.tocSource = 'native';
      return;
    }

    const sections = (book?.sections ?? [])
      .map((section) => {
        const href = section.id?.trim() ?? '';
        if (
          typeof section.size === 'number' &&
          section.size > DEFAULT_DERIVED_TOC_BUDGET.maxSectionTextCharacters
        ) {
          return null;
        }
        const loadText = section.loadText
          ? section.loadText.bind(section)
          : href && book?.loadText
            ? () => book.loadText!(href)
            : null;
        return href && loadText ? { href, loadText } : null;
      })
      .filter((section): section is { href: string; loadText: () => Promise<string | null> } => section !== null);

    const deriveOptions: import('./derivedToc').DeriveEpubTocOptions = {};
    if (options?.sourceFingerprint) {
      deriveOptions.sourceFingerprint = options.sourceFingerprint;
    }
    if (options?.cache) {
      deriveOptions.cache = options.cache;
    }
    try {
      this.derivedToc = await deriveEpubToc(sections, deriveOptions);
    } catch (error) {
      // 目录是可再生成的旁路能力；任何解析/缓存故障都退化为空目录，
      // 不得阻塞已经可以打开的正文。
      console.warn('EPUB 推导目录失败,已退化为空目录', error);
      this.derivedToc = [];
    }
    this.tocSource = 'derived';
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

function getRuntimeCacheRoot(): HTMLElement {
  const existing = document.getElementById('ai-reader-runtime-cache-root');
  if (existing instanceof HTMLElement) return existing;
  const root = document.createElement('div');
  root.id = 'ai-reader-runtime-cache-root';
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText =
    'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;visibility:hidden;pointer-events:none;';
  document.body.appendChild(root);
  return root;
}

function asFoliateBook(value: unknown): FoliateBook | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as FoliateBook;
}

/**
 * foliate-js 的 `createDocument()` 读取原始章节，默认不会经过 Loader 的
 * `data` 事件。搜索必须显式套上与渲染路径相同的规范转换，否则脚本文本、
 * CFI 忽略节点和运行时辅助节点会进入索引，且结果 CFI 会漂移。
 */
function installCanonicalDocumentFactories(
  book: FoliateBook,
  config: FoliateViewOpenOptions['canonicalSearch'] | null,
): void {
  if (!config) return;
  for (const section of book.sections ?? []) {
    const original = section.createDocument;
    if (!original) continue;
    section.createDocument = async () => {
      const source = await original.call(section);
      const serialized = new XMLSerializer().serializeToString(source);
      const transformed = config.transform('application/xhtml+xml', serialized);
      const xhtml = new DOMParser().parseFromString(transformed, 'application/xhtml+xml');
      const canonical =
        xhtml.getElementsByTagName('parsererror').length > 0
          ? new DOMParser().parseFromString(transformed, 'text/html')
          : xhtml;
      removeEpubDisplayOnlyNodes(canonical);
      return canonical;
    };
  }
}

/**
 * Foliate 的默认 Loader 在包内图片/字体损坏时会让整段 XHTML load reject。
 * 非核心资源失败时回退到只含已清洗静态内容的章节 URL,保住正文阅读；
 * 若章节文本本身也不可读,继续抛出原错误,由上层按整章失败展示。
 */
function installSectionFallbacks(
  book: FoliateBook,
  fallbackUrls: Set<string>,
  onReadError?: (error: unknown) => void,
): void {
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
        onReadError?.(error);
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
