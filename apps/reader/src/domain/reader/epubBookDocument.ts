import type {
  BookDocument,
  BookDocumentMetadata,
  ReaderRuntimeResourceUsage,
} from './bookDocument';
import type { ReadingLocation } from './readingLocation';
import type { SearchEvent, SearchOptions } from './search';
import { sanitizeEpubContent } from './sanitizer';
import type { Toc, TocSource } from './toc';
import type { ReadingTypography } from './typography';
import { DEFAULT_READING_TYPOGRAPHY } from './typography';
import {
  DEFAULT_REFLOWABLE_READER_THEME,
  isWorkbenchThemedReflowableFormat,
  transformReflowableEpubThemeResource,
  type ReflowableReaderThemeId,
} from './epubTheme';
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

type CfiReadingLocation = Extract<ReadingLocation, { cfi: string }>;

export interface EpubBookDocumentOptions {
  /** EPUB 的只读、惰性 File/Blob 兼容来源。 */
  source: Blob;
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

  private readonly source: Blob;
  private readonly canonicalTransform: EpubCanonicalTransform;
  private readonly viewHostFactory: FoliateViewHostFactory;
  private readonly locationKind: 'epub' | 'markdown';
  private readonly nativePrefetch: NativeEpubPrefetch | null;
  private readonly sourceFingerprint: string;
  private readonly derivedTocCache: EpubDerivedTocCache | undefined;
  private typography: ReadingTypography = DEFAULT_READING_TYPOGRAPHY;
  private workbenchTheme: ReflowableReaderThemeId = DEFAULT_REFLOWABLE_READER_THEME;
  private host: FoliateViewHost | null = null;
  private container: HTMLElement | null = null;
  private currentLocation: ReadingLocation | null = null;
  private currentProgress: ReadingProgress | null = null;
  // attach/goTo 期间 Foliate 可能在目标位置之后补发一次旧的章节起点 relocate。
  // 在短暂稳定窗口内保留用户请求的精确位置,避免它被过期事件覆盖。
  private requestedLocation: CfiReadingLocation | null = null;
  private requestedLocationTimer: ReturnType<typeof setTimeout> | null = null;
  private detachedLocation: CfiReadingLocation | null = null;
  // 位置变化、书内/外部链接监听器在 host 就绪前也可能被订阅,统一缓冲后接线。
  private locationListeners = new Set<(location: ReadingLocation) => void>();
  private progressListeners = new Set<(progress: ReadingProgress) => void>();
  private internalLinkListeners = new Set<(href: string) => void>();
  private externalLinkListeners = new Set<(href: string) => void>();
  private contentCreateListeners = new Set<(doc: Document) => void>();
  private readErrorListeners = new Set<(error: unknown) => void>();
  private removeHostReadErrorListener: (() => void) | null = null;
  private readonly contentCreateHostCleanups = new Map<
    (doc: Document) => void,
    () => void
  >();
  private opened = false;

  constructor(options: EpubBookDocumentOptions) {
    // BookDocument 只持有只读来源;清洗器与 renderer 后续只能处理派生字符串,
    // 不能通过格式层回写托管原书。ManagedFileSource 的内容由 slice() 按需读取。
    this.source = options.source;
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

    // 必须在 view.open() 前接入安全监听器,否则 Foliate 可能在打开首章时
    // 已经消费 data 事件,导致首章绕过内容清洗。
    this.wireSecurity();
    await view.open(this.source, {
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
    this.removeHostReadErrorListener = view.onReadError?.((error) => {
      for (const listener of this.readErrorListeners) {
        listener(error);
      }
    }) ?? null;
    // 打开后应用排版设置(字体、字号、行距、主题、分页/滚动)。
    this.applyTypographyToHost();
    this.applyWorkbenchThemeToHost();
    await view.init(null);
    this.opened = true;
    this.currentProgress = view.getReadingProgress?.() ?? null;
    // 订阅可能早于 host.open() 建立;此处补接仍未接线的订阅。
    for (const listener of this.contentCreateListeners) this.attachContentCreateListener(listener);
  }

  attach(container: HTMLElement): boolean {
    if (!this.host || !this.opened) return false;
    this.host.attach?.(container);
    this.container = container;
    return true;
  }

  detach(): void {
    for (const contentDocument of this.host?.getContentDocs() ?? []) {
      contentDocument.getSelection?.()?.removeAllRanges();
      (contentDocument.activeElement as HTMLElement | null)?.blur?.();
    }
    const location = this.currentLocation;
    this.detachedLocation = location && 'cfi' in location ? location : null;
    this.host?.detach?.();
    this.container = null;
  }

  isRuntimeReady(): boolean {
    return this.opened;
  }

  getRuntimeResourceUsage(): ReaderRuntimeResourceUsage {
    const contentDocs = this.host?.getContentDocs() ?? [];
    let canvasCount = 0;
    let canvasBytes = 0;
    for (const contentDocument of contentDocs) {
      for (const canvas of contentDocument.querySelectorAll('canvas')) {
        canvasCount += 1;
        canvasBytes += Math.max(0, canvas.width) * Math.max(0, canvas.height) * 4;
      }
    }
    const sourceStats = (this.source as Blob & {
      getRuntimeResourceUsage?: () => Pick<ReaderRuntimeResourceUsage, 'rangeCacheBytes'>;
    }).getRuntimeResourceUsage?.();
    const rangeCacheBytes = sourceStats?.rangeCacheBytes ?? 0;
    return {
      iframeCount: contentDocs.length,
      canvasCount,
      decodedPageCount: 0,
      rangeCacheBytes,
      estimatedBytes: canvasBytes + rangeCacheBytes,
    };
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

  onReadError(listener: (error: unknown) => void): () => void {
    this.readErrorListeners.add(listener);
    return () => this.readErrorListeners.delete(listener);
  }

  async goToLocation(location: ReadingLocation): Promise<void> {
    if (location.kind !== this.locationKind) {
      throw new Error(`不支持的阅读位置类型:${location.kind}`);
    }
    const cfiLocation = location as CfiReadingLocation;
    this.detachedLocation = null;
    this.holdRequestedLocation(cfiLocation);
    try {
      await this.host?.goToLocation(location.cfi);
      this.currentLocation = location;
    } catch (error) {
      this.clearRequestedLocation();
      throw error;
    }
  }

  async next(): Promise<void> {
    this.clearRequestedLocation();
    this.detachedLocation = null;
    await this.host?.next();
  }

  async prev(): Promise<void> {
    this.clearRequestedLocation();
    this.detachedLocation = null;
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
    this.clearRequestedLocation();
    this.detachedLocation = null;
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
    this.applyTypographyToHost();
  }

  applyWorkbenchTheme(theme: ReflowableReaderThemeId): void {
    if (!isWorkbenchThemedReflowableFormat(this.format)) return;
    this.workbenchTheme = theme;
    this.applyWorkbenchThemeToHost();
  }

  isReflowable(): boolean {
    return isWorkbenchThemedReflowableFormat(this.format) && (this.host?.isReflowable?.() ?? true);
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
    this.contentCreateListeners.add(listener);
    this.attachContentCreateListener(listener);
    return () => {
      this.contentCreateListeners.delete(listener);
      this.contentCreateHostCleanups.get(listener)?.();
      this.contentCreateHostCleanups.delete(listener);
    };
  }

  onLocationChange(listener: (location: ReadingLocation) => void): () => void {
    this.locationListeners.add(listener);
    return () => this.locationListeners.delete(listener);
  }

  close(): void {
    this.removeHostReadErrorListener?.();
    this.removeHostReadErrorListener = null;
    this.host?.close();
    this.host = null;
    this.container = null;
    this.opened = false;
    for (const cleanup of this.contentCreateHostCleanups.values()) cleanup();
    this.contentCreateHostCleanups.clear();
    this.currentLocation = null;
    this.currentProgress = null;
    this.clearRequestedLocation();
    this.detachedLocation = null;
    this.locationListeners.clear();
    this.internalLinkListeners.clear();
    this.externalLinkListeners.clear();
    this.contentCreateListeners.clear();
    this.progressListeners.clear();
    this.readErrorListeners.clear();
  }

  private attachContentCreateListener(listener: (doc: Document) => void): void {
    if (!this.host || this.contentCreateHostCleanups.has(listener)) return;
    const host = this.host;
    const cleanup = host.onContentCreate((doc) => {
      removeEpubDisplayOnlyNodes(doc);
      listener(doc);
    });
    this.contentCreateHostCleanups.set(listener, cleanup);
    for (const doc of host.getContentDocs()) {
      removeEpubDisplayOnlyNodes(doc);
      listener(doc);
    }
  }

  private wireSecurity(): void {
    if (!this.host) {
      return;
    }
    // 内容清洗:在文本资源进入渲染器前移除脚本、嵌入、媒体与危险 URL。
    this.host.onContentData((type, data) => {
      const canonical = this.canonicalTransform.transform(type, data);
      return isWorkbenchThemedReflowableFormat(this.format)
        ? transformReflowableEpubThemeResource(type, canonical)
        : canonical;
    });
    // 位置变化事件:把渲染器 CFI 转成可序列化的 ReadingLocation。
    this.host.onRelocate((cfi) => {
      const location: ReadingLocation = { kind: this.locationKind, cfi };
      if (this.detachedLocation && this.detachedLocation.cfi !== cfi) {
        if (isCoarserCfi(cfi, this.detachedLocation.cfi)) return;
        this.detachedLocation = null;
      }
      if (this.requestedLocation && this.requestedLocation.cfi !== cfi) {
        // attach/reflow 期间可能连续派发章节起点、辅助节点和目标范围等
        // 中间事件;明确导航命令会先解除保护,这里不能猜测哪个事件可信。
        return;
      }
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

  private holdRequestedLocation(location: CfiReadingLocation): void {
    this.requestedLocation = location;
    if (this.requestedLocationTimer) clearTimeout(this.requestedLocationTimer);
    this.requestedLocationTimer = setTimeout(() => {
      this.requestedLocation = null;
      this.requestedLocationTimer = null;
    }, 2_000);
  }

  private clearRequestedLocation(): void {
    if (this.requestedLocationTimer) clearTimeout(this.requestedLocationTimer);
    this.requestedLocation = null;
    this.requestedLocationTimer = null;
  }

  private applyTypographyToHost(): void {
    this.host?.applyTypography(this.typography);
  }

  private applyWorkbenchThemeToHost(): void {
    if (!isWorkbenchThemedReflowableFormat(this.format)) return;
    this.host?.applyReflowableTheme?.(this.workbenchTheme);
  }
}

function isCoarserCfi(candidate: string, specific: string): boolean {
  if (candidate === specific) return false;
  const coarseCfi = candidate.endsWith(')') ? candidate.slice(0, -1) : candidate;
  const nextCharacter = specific[coarseCfi.length];
  return specific.startsWith(coarseCfi) &&
    (nextCharacter === ',' || nextCharacter === '!' || nextCharacter === '/' || nextCharacter === '[');
}

export { sanitizeEpubContent };
