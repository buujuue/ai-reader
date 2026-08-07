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
  close(): void;
  lastLocation?: { cfi?: string };
  book?: {
    transformTarget?: EventTarget;
  };
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

  getCurrentCFI(): string | null {
    if (!this.opened) {
      return null;
    }
    return this.element.lastLocation?.cfi ?? null;
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

  /** 阻止外部链接在阅读帧内导航,改由系统浏览器打开(由上层处理)。 */
  private wireExternalLinkBlocking(): void {
    const handler: EventListener = (event) => {
      event.preventDefault();
    };
    this.element.addEventListener('external-link', handler);
    this.externalLinkCleanup = () =>
      this.element.removeEventListener('external-link', handler);
  }

  private contentCleanup: (() => void) | null = null;
  private externalLinkCleanup: (() => void) | null = null;
}