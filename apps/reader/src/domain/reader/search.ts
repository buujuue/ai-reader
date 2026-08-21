/**
 * 当前阅读材料搜索的领域类型。搜索由激活 ReadingView 执行,只针对当前材料,
 * 不跨书建索引。结果以异步增量方式产出,支持取消与命中跳转。
 */

/** 命中上文的摘录:命中前、命中文字、命中后。 */
export interface SearchExcerpt {
  pre: string;
  match: string;
  post: string;
}

/** 单个命中:可定位 CFI 与摘录。 */
export interface SearchMatch {
  cfi: string;
  excerpt: SearchExcerpt;
}

/** 搜索过程中的渐进事件:进度或命中。 */
export type SearchEvent =
  | { kind: 'progress'; progress: number }
  | { kind: 'match'; match: SearchMatch };

export type SearchMode = 'text' | 'regex';

/** 搜索选项。正则模式的预算由领域层固定，调用方不能通过此接口放宽。 */
export interface SearchOptions {
  query: string;
  matchCase?: boolean;
  mode?: SearchMode;
  /** 搜索任务取消时由运行时注入；不是持久化状态。 */
  signal?: AbortSignal;
}
