/**
 * 目录条目(TOC Item):分层阅读结构中的一个节点。
 * 与 foliate-js 的 `book.toc` 结构一致:`{ label, href, subitems }`。
 * href 为书内相对路径,可由 BookDocument 解析后跳转。
 */
export interface TocItem {
  label: string;
  href: string;
  subitems: TocItem[] | null;
  /** 目录来源；仅推导目录设置此标记，原生目录保持兼容的未标记形状。 */
  source?: 'derived';
}

/** 目录条目集合。 */
export type Toc = TocItem[];

/** 目录来源，用于让工作台区分原生目录和本地临时推导目录。 */
export type TocSource = 'native' | 'derived';
