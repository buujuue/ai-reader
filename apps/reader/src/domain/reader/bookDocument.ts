import type { ReadingLocation } from './readingLocation';
import type { SearchEvent, SearchOptions } from './search';
import type { Toc } from './toc';

/** BookDocument 对外暴露的书籍来源元数据。 */
export interface BookDocumentMetadata {
  title: string;
  author: string | null;
  language: string | null;
}

/**
 * BookDocument:TS 阅读领域对 EPUB、PDF、Markdown 的统一文档 Interface。
 * 它向 Reader 提供元数据、目录、导航、位置解析与阅读能力;
 * Reader 外部不得直接依赖 Foliate View 等具体渲染器对象。
 *
 * 第一版只实现 EPUB。所有直接调用具体渲染器(如 Foliate View)的代码
 * 都集中在 BookDocument 的 EPUB 实现内,不泄漏到上层。
 */
export interface BookDocument {
  readonly format: 'epub';
  readonly metadata: BookDocumentMetadata;

  /** 挂载到给定容器并打开文档。容器必须是已插入 DOM 的元素。 */
  open(container: HTMLElement): Promise<void>;

  /** 读取当前阅读位置(可序列化)。 */
  getLocation(): ReadingLocation | null;

  /** 恢复到指定阅读位置。 */
  goToLocation(location: ReadingLocation): Promise<void>;

  /** 解析并跳到书内 href(目录节点或书内链接)。 */
  goToHref(href: string): Promise<void>;

  /** 读取分层目录。 */
  getTOC(): Toc;

  /**
   * 在当前阅读材料内搜索正文。异步增量产出进度与命中;调用方可 `return()`
   * 提前取消。生成器自然结束时即搜索完成。
   */
  search(options: SearchOptions): AsyncGenerator<SearchEvent, void, void>;

  /** 清除搜索产生的命中高亮与临时结果。 */
  clearSearch(): void;

  /** 下一页。 */
  next(): Promise<void>;

  /** 上一页。 */
  prev(): Promise<void>;

  /** 订阅书内链接点击,收到待跳转的 href。返回取消订阅函数。 */
  onInternalLink(listener: (href: string) => void): () => void;

  /** 订阅书内点击的外部链接,收到目标 URL。返回取消订阅函数。 */
  onExternalLink(listener: (href: string) => void): () => void;

  /** 订阅阅读位置变化。返回取消订阅函数。 */
  onLocationChange(listener: (location: ReadingLocation) => void): () => void;

  /** 销毁文档并释放渲染器资源。 */
  close(): void;
}