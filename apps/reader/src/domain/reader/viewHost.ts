import type { SearchEvent, SearchOptions } from './search';
import type { Toc } from './toc';
import type { ReadingTypography } from './typography';
import type { NativeEpubPrefetch } from './nativeEpub';
import type { ReadingProgress } from './readingProgress';

/** BookDocument 传给 Foliate 宿主的可选机械预取。 */
export interface FoliateViewOpenOptions {
  epubPrefetch?: NativeEpubPrefetch | null;
}

/**
 * Foliate 视图宿主的窄接口。它把具体渲染器隔离在 BookDocument 的 EPUB 实现内,
 * 上层(Reader Runtime、组件)只通过 BookDocument 与 ReadingLocation 交互。
 */
export interface FoliateViewHost {
  /** 打开文档字节。`book` 通常是 File/Blob。 */
  open(book: unknown, options?: FoliateViewOpenOptions): Promise<void>;
  /** 初始化到给定位置;位置为空时跳到正文开头。 */
  init(location: unknown): Promise<void>;
  /** 下一页。 */
  next(): Promise<void>;
  /** 上一页。 */
  prev(): Promise<void>;
  /** 跳到指定位置。 */
  goToLocation(location: unknown): Promise<void>;
  /** 解析并跳到书内 href(目录节点或书内链接)。 */
  goToHref(href: string): Promise<void>;
  /** 读取当前 CFI(阅读位置)。 */
  getCurrentCFI(): string | null;
  /** 读取当前可展示的章节/总进度；固定版式也尽力提供章节进度。 */
  getReadingProgress?(): ReadingProgress | null;
  /** 订阅可展示的位置反馈，不携带 Range 等运行时对象。 */
  onProgressChange?(listener: (progress: ReadingProgress) => void): () => void;
  /** 读取分层目录。 */
  getTOC(): Toc;
  /**
   * 在当前文档内搜索正文。以异步增量方式产出进度与命中;调用方可通过
   * `return()` 提前终止(取消)。返回的生成器自然结束时即搜索完成。
   */
  search(options: SearchOptions): AsyncGenerator<SearchEvent, void, void>;
  /** 清除搜索产生的命中高亮与临时结果。 */
  clearSearch(): void;
  /** 订阅阅读位置变化(CFI)。返回取消订阅函数。 */
  onRelocate(listener: (cfi: string) => void): () => void;
  /** 订阅书内链接点击,收到待跳转的 href。返回取消订阅函数。 */
  onInternalLink(listener: (href: string) => void): () => void;
  /** 订阅书内点击的外部链接,收到目标 URL。返回取消订阅函数。 */
  onExternalLink(listener: (href: string) => void): () => void;
  /**
   * 订阅文档内容加载(如 XHTML/SVG/CSS),可改写内容后再交给渲染器。
   * 用于清洗不可信 EPUB 内容。返回取消订阅函数。
   */
  onContentData(listener: (type: string, data: string) => string): () => void;

  /**
   * 读取当前已加载的内容文档(iframe 内)。用于给阅读内容附加输入监听器。
   * 渲染器尚未就绪时返回空数组。
   */
  getContentDocs(): readonly Document[];

  /**
   * 订阅新内容文档的创建(随章节翻页/加载而出现)。
   * 用于把输入监听器附加到每个新内容文档上。返回取消订阅函数。
   */
  onContentCreate(listener: (doc: Document) => void): () => void;
  /**
   * 应用排版设置(字体、字号、行距、页边距、主题、分页/滚动)。
   * 只注入固定映射生成的 CSS 与渲染器 attribute,不放开安全边界。
   */
  applyTypography(settings: ReadingTypography): void;

  /**
   * 生成给定内容文档中某 Range 的规范化 CFI(index 为内容文档所在章节序号)。
   * 用于把用户选中文本转成可持久化的文本锚点。
  */
  getCFI(index: number, range: Range): string;

  /** 在不改变当前阅读位置的前提下尝试解析一个批注 CFI。 */
  canResolveAnnotation?(value: string): Promise<boolean>;

  /** 读取当前内容文档所在章节序号(index);未就绪时返回 null。 */
  getCurrentIndex(): number | null;

  /** 返回已加载内容文档对应的 spine section 序号。 */
  getContentDocumentIndex?(document: Document): number | null;

  /**
   * 绘制一条高亮批注。`value` 为 CFI,`color` 为高亮颜色。重复绘制同一 CFI 会替换旧覆盖层。
   */
  addAnnotation(annotation: { value: string; color: string }): void;

  /** 移除一条高亮批注的覆盖层(按 CFI)。 */
  removeAnnotation(value: string): void;

  /** 订阅对高亮覆盖层的点击(收到被点击批注的 CFI)。返回取消订阅函数。 */
  onShowAnnotation(listener: (value: string) => void): () => void;

  /** 销毁并释放渲染器。 */
  close(): void;
}

/** 创建 Foliate 视图宿主的工厂窄缝(生产懒加载 foliate-js,测试注入伪宿主)。 */
export type FoliateViewHostFactory = (container: HTMLElement) => FoliateViewHost;
