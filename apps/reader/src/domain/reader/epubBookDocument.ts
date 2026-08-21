import type { BookDocument, BookDocumentMetadata } from './bookDocument';
import type { ReadingLocation } from './readingLocation';
import type { SearchEvent, SearchOptions } from './search';
import { sanitizeEpubContent } from './sanitizer';
import type { Toc, TocSource } from './toc';
import type { ReadingTypography } from './typography';
import { DEFAULT_READING_TYPOGRAPHY } from './typography';
import type { FoliateViewHost, FoliateViewHostFactory } from './viewHost';
import type { NativeEpubPrefetch } from './nativeEpub';
import type { ReadingProgress } from './readingProgress';
import type { EpubDerivedTocCache } from './derivedToc';
import {
  createEpubCanonicalTransform,
  removeEpubDisplayOnlyNodes,
  type EpubCanonicalTransform,
  type EpubDerivedCache,
} from './epubCanonical';
import type { CanonicalSearchIndexCache } from './canonicalSearch';

export interface EpubBookDocumentOptions {
  /** EPUB 字节内容。 */
  bytes: Uint8Array;
  /** 来源元数据(经 EpubInspector 提取)。 */
  metadata: BookDocumentMetadata;
  /** 可注入的 Foliate 视图宿主工厂(测试用)。 */
  viewHostFactory: FoliateViewHostFactory;
  /** 文档格式(EPUB 实现缺省为 epub;Markdown 子类传入 markdown)。 */
  format?: 'epub' | 'markdown';
  /** ReadingLocation 的 kind(缺省与 format 一致;Markdown 子类传入 markdown)。 */
  locationKind?: 'epub' | 'markdown';
  /** 已通过 parity 的原生机械预取;失败或不支持时为空并走纯 JS。 */
  nativePrefetch?: NativeEpubPrefetch | null;
  /** 完整内容指纹,用于隔离规范转换派生缓存。 */
  sourceFingerprint?: string;
  /** 规范转换版本;升级后旧派生结果不会复用。 */
  canonicalTransformVersion?: string;
  /** 可注入的规范转换派生缓存;默认使用当前文档的内存缓存。 */
  derivedCache?: EpubDerivedCache<string>;
  /** 可重建全文搜索索引缓存;不保存原书字节。 */
  searchIndexCache?: CanonicalSearchIndexCache;
  /** 可注入的推导目录缓存;只保存带版本的目录 JSON。 */
  derivedTocCache?: EpubDerivedTocCache;
}

/**
 * EPUB(及复用 Foliate 分页器的 Markdown)的 BookDocument 实现。
 * 它把不可信内容清洗、Foliate 渲染器挂载、位置读取/恢复与导航统一封装在窄接口之后;
 * 上层绝不直接操作 Foliate View。
 */
export class EpubBookDocument implements BookDocument {
  readonly format: 'epub' | 'markdown';
  readonly metadata: BookDocumentMetadata;

  private readonly bytes: Uint8Array;
  private readonly canonicalTransform: EpubCanonicalTransform;
  private readonly viewHostFactory: FoliateViewHostFactory;
  private readonly locationKind: 'epub' | 'markdown';
  private readonly nativePrefetch: NativeEpubPrefetch | null;
  private readonly sourceFingerprint: string;
  private readonly derivedTocCache: EpubDerivedTocCache | undefined;
  private typography: ReadingTypography = DEFAULT_READING_TYPOGRAPHY;
  private host: FoliateViewHost | null = null;
  private container: HTMLElement | null = null;
  private currentLocation: ReadingLocation | null = null;
  private currentProgress: ReadingProgress | null = null;
  // 位置变化、书内/外部链接监听器在 host 就绪前也可能被订阅,统一缓冲后接线。
  private locationListeners = new Set<(location: ReadingLocation) => void>();
  private progressListeners = new Set<(progress: ReadingProgress) => void>();
  private internalLinkListeners = new Set<(href: string) => void>();
  private externalLinkListeners = new Set<(href: string) => void>();
  private contentCreateListeners = new Set<(doc: Document) => void>();

  constructor(options: EpubBookDocumentOptions) {
    // BookDocument 只拥有原书的副本;清洗器与 renderer 后续只能处理派生字符串,
    // 不能通过调用方缓冲区回写托管原书。
    this.bytes = new Uint8Array(options.bytes);
    this.metadata = options.metadata;
    this.viewHostFactory = options.viewHostFactory;
    this.format = options.format ?? 'epub';
    this.locationKind = options.locationKind ?? this.format;
    this.nativePrefetch = options.nativePrefetch ?? null;
    this.sourceFingerprint = options.sourceFingerprint ?? 'unknown-source';
    this.derivedTocCache = options.derivedTocCache;
    const canonicalOptions = {
      sourceFingerprint: this.sourceFingerprint,
      ...(options.derivedCache ? { cache: options.derivedCache } : {}),
      ...(options.canonicalTransformVersion
        ? { transformVersion: options.canonicalTransformVersion }
        : {}),
    };
    this.canonicalTransform = createEpubCanonicalTransform(canonicalOptions);
    this.searchIndexCache = options.searchIndexCache;
  }

  private readonly searchIndexCache: CanonicalSearchIndexCache | undefined;

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
    // 必须在 view.open() 前接入安全监听器,否则 Foliate 可能在打开首章时
    // 已经消费 data 事件,导致首章绕过内容清洗。
    this.wireSecurity();
    await view.open(file, {
      epubPrefetch: this.nativePrefetch,
      ...(this.format === 'epub'
        ? {
            derivedToc: {
              sourceFingerprint: this.sourceFingerprint,
              ...(this.derivedTocCache ? { cache: this.derivedTocCache } : {}),
            },
          }
        : {}),
      canonicalSearch: {
        sourceFingerprint: this.sourceFingerprint,
        canonicalTransformVersion: this.canonicalTransform.version,
        transform: this.canonicalTransform.transform.bind(this.canonicalTransform),
        ...(this.searchIndexCache ? { cache: this.searchIndexCache } : {}),
      },
    });
    // 打开后应用排版设置(字体、字号、行距、主题、分页/滚动)。
    view.applyTypography(this.typography);
    await view.init(null);
    this.currentProgress = view.getReadingProgress?.() ?? null;
    // host 就绪后,把此前缓冲的内容创建订阅转发给 host,并补发已存在的文档。
    for (const listener of this.contentCreateListeners) {
      view.onContentCreate((doc) => {
        removeEpubDisplayOnlyNodes(doc);
        listener(doc);
      });
      for (const doc of view.getContentDocs()) {
        removeEpubDisplayOnlyNodes(doc);
        listener(doc);
      }
    }
  }

  getLocation(): ReadingLocation | null {
    return this.currentLocation;
  }

  getReadingProgress(): ReadingProgress | null {
    return this.currentProgress ?? this.host?.getReadingProgress?.() ?? null;
  }

  onProgressChange(listener: (progress: ReadingProgress) => void): () => void {
    this.progressListeners.add(listener);
    if (this.currentProgress) listener(this.currentProgress);
    return () => this.progressListeners.delete(listener);
  }

  async goToLocation(location: ReadingLocation): Promise<void> {
    if (location.kind !== this.locationKind) {
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

  getCFI(index: number, range: Range): string {
    return this.host?.getCFI(index, range) ?? '';
  }

  async canResolveAnnotation(value: string): Promise<boolean> {
    return (await this.host?.canResolveAnnotation?.(value)) ?? false;
  }

  getCurrentIndex(): number | null {
    return this.host?.getCurrentIndex() ?? null;
  }

  getContentDocumentIndex(document: Document): number | null {
    return this.host?.getContentDocumentIndex?.(document) ?? null;
  }

  addAnnotation(annotation: { value: string; color: string }): void {
    this.host?.addAnnotation(annotation);
  }

  removeAnnotation(value: string): void {
    this.host?.removeAnnotation(value);
  }

  onShowAnnotation(listener: (value: string) => void): () => void {
    return this.host?.onShowAnnotation(listener) ?? (() => undefined);
  }

  async goToHref(href: string): Promise<void> {
    await this.host?.goToHref(href);
  }

  getTOC(): Toc {
    return this.host?.getTOC() ?? [];
  }

  getTOCSource(): TocSource {
    return this.host?.getTOCSource?.() ?? 'native';
  }

  search(options: SearchOptions): AsyncGenerator<SearchEvent, void, void> {
    if (!this.host) {
      return (async function* searchNoHost() {
        /* 文档未打开,不产出任何事件 */
      })();
    }
    return this.host.search(options);
  }

  clearSearch(): void {
    this.host?.clearSearch();
  }

  applyTypography(settings: ReadingTypography): void {
    this.typography = settings;
    this.host?.applyTypography(settings);
  }

  onInternalLink(listener: (href: string) => void): () => void {
    this.internalLinkListeners.add(listener);
    return () => this.internalLinkListeners.delete(listener);
  }

  onExternalLink(listener: (href: string) => void): () => void {
    this.externalLinkListeners.add(listener);
    return () => this.externalLinkListeners.delete(listener);
  }

  getContentDocs(): readonly Document[] {
    return (this.host?.getContentDocs() ?? []).map((doc) => {
      removeEpubDisplayOnlyNodes(doc);
      return doc;
    });
  }

  onContentCreate(listener: (doc: Document) => void): () => void {
    // host 可能尚未就绪(组件在 open() 完成前订阅),先缓冲,待 host 就绪后统一转发。
    this.contentCreateListeners.add(listener);
    if (this.host) {
      this.host.onContentCreate((doc) => {
        removeEpubDisplayOnlyNodes(doc);
        listener(doc);
      });
      for (const doc of this.host.getContentDocs()) {
        removeEpubDisplayOnlyNodes(doc);
        listener(doc);
      }
    }
    return () => this.contentCreateListeners.delete(listener);
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
    this.currentProgress = null;
    this.locationListeners.clear();
    this.internalLinkListeners.clear();
    this.externalLinkListeners.clear();
    this.contentCreateListeners.clear();
    this.progressListeners.clear();
  }

  private wireSecurity(): void {
    if (!this.host) {
      return;
    }
    // 内容清洗:在文本资源进入渲染器前移除脚本、嵌入、媒体与危险 URL。
    this.host.onContentData((type, data) => this.canonicalTransform.transform(type, data));
    // 位置变化事件:把渲染器 CFI 转成可序列化的 ReadingLocation。
    this.host.onRelocate((cfi) => {
      const location: ReadingLocation = { kind: this.locationKind, cfi };
      this.currentLocation = location;
      for (const listener of this.locationListeners) {
        listener(location);
      }
    });
    this.host.onProgressChange?.((progress) => {
      this.currentProgress = progress;
      for (const listener of this.progressListeners) {
        listener(progress);
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
