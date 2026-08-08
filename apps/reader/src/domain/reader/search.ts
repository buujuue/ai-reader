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

/** 搜索选项。第一版支持普通文本与大小写开关。 */
export interface SearchOptions {
  query: string;
  matchCase?: boolean;
}