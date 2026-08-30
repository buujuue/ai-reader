import type { ReadingLocation } from './readingLocation';
import type { SearchEvent, SearchOptions } from './search';
import type { Toc } from './toc';
import type { TocSource } from './toc';
import type { ReadingTypography } from './typography';
import type { ReadingProgress } from './readingProgress';

/** BookDocument 对外暴露的书籍来源元数据。 */
export interface BookDocumentMetadata {
  title: string;
  author: string | null;
  language: string | null;
}

/**
 * PDF 扫描页或其它固定版式页面的临时区域选择。
 * `clientRect` 只服务于当前工具栏定位,真正持久化时只保存 `page` 与 `rect`。
 */
export interface AreaSelection {
  page: number;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  clientRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

/** Reader Runtime 活对象的可获得资源快照；不进入 Workspace State。 */
export interface ReaderRuntimeResourceUsage {
  iframeCount: number;
  canvasCount: number;
  decodedPageCount: number;
  rangeCacheBytes: number;
  estimatedBytes: number;
}

/**
 * BookDocument:TS 阅读领域对 EPUB、PDF、Markdown 的统一文档 Interface。
 * 它向 Reader 提供元数据、目录、导航、位置解析与阅读能力;
 * Reader 外部不得直接依赖 Foliate View 等具体渲染器对象。
 *
 * EPUB、PDF、Markdown 的具体渲染器调用都集中在各自 BookDocument 实现内，
 * 不泄漏到上层；attach/detach 是 EPUB/Markdown 有界 Runtime 缓存的可选能力。
 */
export interface BookDocument {
  readonly format: 'epub' | 'pdf' | 'markdown';
  readonly metadata: BookDocumentMetadata;

  /**
   * 生成封面图像(Blob)。EPUB 封面提取由托管封面系统承担,本接口为可选;
   * PDF 实现渲染首页为封面。不可用或尚未实现时返回 null。
   */
  getCover?(): Promise<Blob | null>;

  /** 挂载到给定容器并打开文档。容器必须是已插入 DOM 的元素。 */
  open(container: HTMLElement): Promise<void>;

  /**
   * 把已经打开但被挂起的 renderer 重新接回新容器；返回 false 表示仍需 open()。
   * 该能力只用于 EPUB/Markdown 有界 Runtime 缓存，PDF 不实现所以继续重建。
   */
  attach?(container: HTMLElement): boolean;

  /** 从界面容器摘下 renderer，但不销毁 BookDocument 或其派生运行时。 */
  detach?(): void;

  /** 返回文档是否已完成首次打开，可用于阻止缓存未完成的加载任务。 */
  isRuntimeReady?(): boolean;

  /** 读取可获得的 iframe、Canvas、解码页和范围缓存资源估算。 */
  getRuntimeResourceUsage?(): ReaderRuntimeResourceUsage;

  /** 读取当前阅读位置(可序列化)。 */
  getLocation(): ReadingLocation | null;

  /** 读取当前可展示的章节/总进度；不进入可恢复工作区状态。 */
  getReadingProgress?(): ReadingProgress | null;

  /** 订阅当前可展示的位置反馈。 */
  onProgressChange?(listener: (progress: ReadingProgress) => void): () => void;

  /** 订阅打开后发生的内容读取/渲染错误,供工作台展示可诊断反馈。 */
  onReadError?(listener: (error: unknown) => void): () => void;

  /** 恢复到指定阅读位置。 */
  goToLocation(location: ReadingLocation): Promise<void>;

  /** 解析并跳到书内 href(目录节点或书内链接)。 */
  goToHref(href: string): Promise<void>;

  /** 读取分层目录。 */
  getTOC(): Toc;

  /** 读取目录来源；推导目录是本地非权威的运行时数据。 */
  getTOCSource?(): TocSource;

  /**
   * 在当前阅读材料内搜索正文。异步增量产出进度与命中;调用方可 `return()`
   * 提前取消。生成器自然结束时即搜索完成。
   */
  search(options: SearchOptions): AsyncGenerator<SearchEvent, void, void>;

  /** 清除搜索产生的命中高亮与临时结果。 */
  clearSearch(): void;

  /**
   * 应用排版设置(字体、字号、行距、页边距、主题、分页/滚动)。
   * 可在打开前调用(打开后生效),也可在打开途中调用以实时调整。
   */
  applyTypography(settings: ReadingTypography): void;

  /** 下一页。 */
  next(): Promise<void>;

  /** 上一页。 */
  prev(): Promise<void>;

  /**
   * 生成给定内容文档中某 Range 的规范化 CFI(index 为内容文档所在章节序号)。
   * 用于把用户选中文本转成可持久化的文本锚点。
  */
  getCFI(index: number, range: Range): string;

  /** 在不改变当前阅读位置的前提下尝试解析一个批注 CFI。 */
  canResolveAnnotation?(value: string): Promise<boolean>;

  /** 把固定版式区域选择转换为持久化锚点;仅 PDF 实现提供。 */
  getAreaAnchor?(selection: AreaSelection): string;

  /** 订阅固定版式区域选择;仅 PDF 实现提供。 */
  onAreaSelection?(listener: (selection: AreaSelection) => void): () => void;

  /** 读取当前内容文档所在章节序号(index);未就绪时返回 null。 */
  getCurrentIndex(): number | null;

  /**
   * 返回一个内容 iframe 所属的 spine section 序号。
   * 这是可选能力，供 EPUB 选择提交前校验 Range 是否仍位于同一章节；
   * 不支持该映射的格式由实现使用当前章节作为兼容回退。
   */
  getContentDocumentIndex?(document: Document): number | null;

  /** 绘制一条高亮批注(经宿主覆盖层渲染,颜色取自批注)。 */
  addAnnotation(annotation: { value: string; color: string }): void;

  /** 移除一条高亮批注的覆盖层(按 CFI)。 */
  removeAnnotation(value: string): void;

  /** 订阅对高亮覆盖层的点击(收到被点击批注的 CFI)。返回取消订阅函数。 */
  onShowAnnotation(listener: (value: string) => void): () => void;

  /** 订阅书内链接点击,收到待跳转的 href。返回取消订阅函数。 */
  onInternalLink(listener: (href: string) => void): () => void;

  /** 订阅书内点击的外部链接,收到目标 URL。返回取消订阅函数。 */
  onExternalLink(listener: (href: string) => void): () => void;

  /** 读取当前已加载的内容文档(iframe 内),用于附加阅读输入监听器。 */
  getContentDocs(): readonly Document[];

  /** 订阅新内容文档的创建(随翻页/加载出现),用于持续附加输入监听器。 */
  onContentCreate(listener: (doc: Document) => void): () => void;

  /** 订阅阅读位置变化。返回取消订阅函数。 */
  onLocationChange(listener: (location: ReadingLocation) => void): () => void;

  /** 销毁文档并释放渲染器资源。 */
  close(): void;
}
