import type { BookDocument, BookDocumentMetadata } from './bookDocument';
import type { ReadingLocation } from './readingLocation';
import { sanitizeEpubContent } from './sanitizer';
import type { Toc } from './toc';
import type { FoliateViewHost, FoliateViewHostFactory } from './viewHost';

export interface EpubBookDocumentOptions {
  /** EPUB 字节内容。 */
  bytes: Uint8Array;
  /** 来源元数据(经 EpubInspector 提取)。 */
  metadata: BookDocumentMetadata;
  /** 可注入的 Foliate 视图宿主工厂(测试用)。 */
  viewHostFactory: FoliateViewHostFactory;
  /** 是否启用内容清洗(安全开关,默认开启且不可在阅读时关闭)。 */
  sanitize?: boolean;
}

/**
 * EPUB 的 BookDocument 实现。它把不可信内容清洗、Foliate 渲染器挂载、
 * 位置读取/恢复与导航统一封装在窄接口之后;上层绝不直接操作 Foliate View。
 */
export class EpubBookDocument implements BookDocument {
  readonly format = 'epub' as const;
  readonly metadata: BookDocumentMetadata;

  private readonly bytes: Uint8Array;
  private readonly viewHostFactory: FoliateViewHostFactory;
  private readonly sanitize: boolean;
  private host: FoliateViewHost | null = null;
  private container: HTMLElement | null = null;
  private currentLocation: ReadingLocation | null = null;
  private locationListeners = new Set<(location: ReadingLocation) => void>();
  private internalLinkListeners = new Set<(href: string) => void>();
  private externalLinkListeners = new Set<(href: string) => void>();

  constructor(options: EpubBookDocumentOptions) {
    this.bytes = options.bytes;
    this.metadata = options.metadata;
    this.viewHostFactory = options.viewHostFactory;
    this.sanitize = options.sanitize ?? true;
  }

  async open(container: HTMLElement): Promise<void> {
    if (this.host) {
      throw new Error('该 BookDocument 已打开');
    }
    this.container = container;
    const view = this.viewHostFactory(container);
    this.host = view;

    const file = new File([this.bytes.buffer.slice(0) as ArrayBuffer], 'book.epub', {
      type: 'application/epub+zip',
    });
    await view.open(file);
    this.wireSecurity();
    await view.init(null);
  }

  getLocation(): ReadingLocation | null {
    return this.currentLocation;
  }

  async goToLocation(location: ReadingLocation): Promise<void> {
    if (location.kind !== 'epub') {
      throw new Error(`不支持的阅读位置类型:${location.kind}`);
    }
    await this.host?.goToLocation(location.cfi);
    this.currentLocation = location;
  }

  async next(): Promise<void> {
    await this.host?.next();
  }

  async prev(): Promise<void> {
    await this.host?.prev();
  }

  async goToHref(href: string): Promise<void> {
    await this.host?.goToHref(href);
  }

  getTOC(): Toc {
    return this.host?.getTOC() ?? [];
  }

  onInternalLink(listener: (href: string) => void): () => void {
    this.internalLinkListeners.add(listener);
    return () => this.internalLinkListeners.delete(listener);
  }

  onExternalLink(listener: (href: string) => void): () => void {
    this.externalLinkListeners.add(listener);
    return () => this.externalLinkListeners.delete(listener);
  }

  onLocationChange(listener: (location: ReadingLocation) => void): () => void {
    this.locationListeners.add(listener);
    return () => this.locationListeners.delete(listener);
  }

  close(): void {
    this.host?.close();
    this.host = null;
    this.container = null;
    this.currentLocation = null;
    this.locationListeners.clear();
    this.internalLinkListeners.clear();
    this.externalLinkListeners.clear();
  }

  private wireSecurity(): void {
    if (!this.host) {
      return;
    }
    // 内容清洗:在内容进入渲染器前移除脚本、iframe、对象嵌入与危险 URL。
    if (this.sanitize) {
      this.host.onContentData((type, data) => {
        if (type === 'application/xhtml+xml' || type === 'text/html') {
          return sanitizeEpubContent(data);
        }
        return data;
      });
    }
    // 位置变化事件:把渲染器 CFI 转成可序列化的 ReadingLocation。
    this.host.onRelocate((cfi) => {
      const location: ReadingLocation = { kind: 'epub', cfi };
      this.currentLocation = location;
      for (const listener of this.locationListeners) {
        listener(location);
      }
    });
    // 书内链接:把 href 面向上层,由上层统一导航(压入历史)。
    this.host.onInternalLink((href) => {
      for (const listener of this.internalLinkListeners) {
        listener(href);
      }
    });
    // 外部链接:把目标 URL 面向上层,由上层交给系统浏览器。
    this.host.onExternalLink((href) => {
      for (const listener of this.externalLinkListeners) {
        listener(href);
      }
    });
  }
}

export { sanitizeEpubContent };