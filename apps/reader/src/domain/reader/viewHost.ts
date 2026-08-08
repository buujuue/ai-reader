import type { Toc, TocItem } from './toc';

/**
 * Foliate 视图宿主的窄接口。它把具体渲染器隔离在 BookDocument 的 EPUB 实现内,
 * 上层(Reader Runtime、组件)只通过 BookDocument 与 ReadingLocation 交互。
 */
export interface FoliateViewHost {
  /** 打开文档字节。`book` 通常是 File/Blob。 */
  open(book: unknown): Promise<void>;
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
  /** 读取分层目录。 */
  getTOC(): Toc;
  /** 订阅阅读位置变化(CFI)。返回取消订阅函数。 */
  onRelocate(listener: (cfi: string) => void): () => void;
  /** 订阅书内链接点击,收到待跳转的 href。返回取消订阅函数。 */
  onInternalLink(listener: (href: string) => void): () => void;
  /** 订阅书内点击的外部链接,收到目标 URL。返回取消订阅函数。 */
  onExternalLink(listener: (href: string) => void): () => void;
  /**
   * 订阅文档内容加载(如 XHTML/CSS),可改写内容后再交给渲染器。
   * 用于清洗不可信 EPUB 内容。返回取消订阅函数。
   */
  onContentData(listener: (type: string, data: string) => string): () => void;
  /** 销毁并释放渲染器。 */
  close(): void;
}

/** 创建 Foliate 视图宿主的工厂窄缝(生产懒加载 foliate-js,测试注入伪宿主)。 */
export type FoliateViewHostFactory = (container: HTMLElement) => FoliateViewHost;