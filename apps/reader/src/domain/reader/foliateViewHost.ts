import type { SearchEvent, SearchOptions } from './search';
import type { ReadingTypography } from './typography';
import { buildTypographyCss } from './typography';
import type { FoliateViewHost, FoliateViewHostFactory } from './viewHost';

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
  search(opts: SearchOptions): AsyncGenerator<unknown, void, unknown>;
  clearSearch(): void;
  close(): void;
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
  private contentListeners = new Set<(type: string, data: string) => string>();
  private internalLinkListeners = new Set<(href: string) => void>();
  private externalLinkListeners = new Set<(href: string) => void>();

  constructor(
    element: ExtendedFoliateView,
    viewModule: Promise<typeof import('foliate-js/view.js')>,
  ) {
    this.element = element;
    this.viewModule = viewModule;
  }

  async open(book: unknown): Promise<void> {
    await this.viewModule;
    await this.element.open(book);
    this.opened = true;
    this.wireContentSanitization();
    this.wireInternalLinkHandling();
    this.wireExternalLinkBlocking();
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

  close(): void {
    if (this.opened) {
      this.element.close?.();
    }
    this.element.remove();
    this.contentListeners.clear();
    this.internalLinkListeners.clear();
    this.externalLinkListeners.clear();
    this.opened = false;
  }

  /** 在 foliate Loader 派发 `data` 事件时对不可信内容做清洗。 */
  private wireContentSanitization(): void {
    const target = this.element.book?.transformTarget;
    if (!target) {
      return;
    }
    const handler: EventListener = (event) => {
      const detail = (event as CustomEvent<{ data?: string; type?: string }>).detail;
      if (typeof detail?.data !== 'string' || typeof detail?.type !== 'string') {
        return;
      }
      for (const listener of this.contentListeners) {
        detail.data = listener(detail.type, detail.data);
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
}