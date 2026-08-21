import type { SearchMode, SearchOptions } from './search';

/** 规范可读文本搜索的算法版本。改变文本节点筛选或偏移映射时必须递增。 */
export const CANONICAL_SEARCH_INDEX_VERSION = 'canonical-search-v1';
/** 改变普通/正则匹配语义时递增，旧索引随后安全失效并重建。 */
export const CANONICAL_SEARCH_QUERY_CONFIG_VERSION = 'search-query-v1';

/** 正则表达式最多允许 256 个 UTF-16 code units。 */
export const MAX_REGEX_PATTERN_LENGTH = 256;
/** 单个材料的正则命中硬上限。 */
export const MAX_REGEX_RESULTS = 1_000;
/** 单章节正则匹配预算；每章节重新计时。 */
export const REGEX_SECTION_TIMEOUT_MS = 50;
/** 单章节正文索引上限，防止把异常资源变成无界字符串。 */
export const MAX_SEARCH_SECTION_CHARACTERS = 1_000_000;
/** 单材料索引总字符上限；超过后交给调用方显示错误并可重建。 */
export const MAX_SEARCH_INDEX_CHARACTERS = 8_000_000;
const CONTEXT_LENGTH = 50;

export type SearchBudgetErrorCode =
  | 'INVALID_REGEX'
  | 'REGEX_TOO_LONG'
  | 'REGEX_UNSAFE'
  | 'REGEX_TIMEOUT'
  | 'REGEX_UNAVAILABLE'
  | 'REGEX_RESULT_LIMIT'
  | 'SEARCH_SECTION_LIMIT'
  | 'SEARCH_INDEX_LIMIT'
  | 'SEARCH_CANCELLED';

/** 搜索失败的稳定错误类型；UI 可据 code 给出明确状态。 */
export class SearchBudgetError extends Error {
  readonly code: SearchBudgetErrorCode;

  constructor(code: SearchBudgetErrorCode, message: string) {
    super(message);
    this.name = 'SearchBudgetError';
    this.code = code;
  }
}

interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

export interface CanonicalSectionText {
  readonly text: string;
  readonly textNodes: readonly TextSpan[];
  /** 把规范文本偏移映射回同一份 DOM 的 Range，供 CFI 与高亮使用。 */
  range(start: number, end: number): Range;
}

export interface CanonicalSearchMatch {
  start: number;
  end: number;
  range: Range;
  excerpt: {
    pre: string;
    match: string;
    post: string;
  };
}

export interface RegexMatchOffset {
  start: number;
  end: number;
}

export interface SearchBudgetState {
  resultCount: number;
}

interface MatchRuntimeOptions {
  now?: () => number;
}

/**
 * 为单个章节建立可读文本视图。文本仍按节点保存，`text` 只限制在单章节内；
 * 不会把整本书拼成一个无界字符串。脚注是正文语义的一部分，展示辅助节点和
 * CFI 忽略节点则被排除。
 */
export function createCanonicalSectionText(doc: Document): CanonicalSectionText {
  const walker = doc.createTreeWalker(doc.body ?? doc, NodeFilter.SHOW_TEXT);
  const textNodes: TextSpan[] = [];
  let text = '';
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    if (!node.nodeValue || isIgnoredTextNode(node)) continue;
    const start = text.length;
    text += node.nodeValue;
    textNodes.push({ node, start, end: text.length });
    if (text.length > MAX_SEARCH_SECTION_CHARACTERS) {
      throw new SearchBudgetError(
        'SEARCH_SECTION_LIMIT',
        `单章节可搜索文本超过 ${MAX_SEARCH_SECTION_CHARACTERS} 个字符`,
      );
    }
  }

  return {
    text,
    textNodes,
    range(start, end) {
      if (start < 0 || end <= start || end > text.length || textNodes.length === 0) {
        throw new RangeError('搜索命中范围无效');
      }
      const startPoint = locateBoundary(textNodes, start, false);
      const endPoint = locateBoundary(textNodes, end, true);
      const range = textNodes[0]!.node.ownerDocument.createRange();
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset);
      return range;
    },
  };
}

/** 在单章节中寻找普通文本或安全正则命中。结果按正文顺序产出。 */
export function* findCanonicalSectionMatches(
  section: CanonicalSectionText,
  options: Pick<SearchOptions, 'query' | 'matchCase' | 'mode'>,
  state: SearchBudgetState = { resultCount: 0 },
  runtime: MatchRuntimeOptions = {},
): Generator<CanonicalSearchMatch, void, void> {
  const query = options.query;
  if (!query) return;

  const mode: SearchMode = options.mode ?? 'text';
  if (mode === 'regex') {
    yield* findRegexMatches(section, query, options.matchCase ?? false, state, runtime);
    return;
  }

  const haystack = options.matchCase ? section.text : section.text.toLocaleLowerCase();
  const needle = options.matchCase ? query : query.toLocaleLowerCase();
  let cursor = 0;
  while (needle.length > 0) {
    const start = haystack.indexOf(needle, cursor);
    if (start < 0) return;
    const end = start + needle.length;
    yield createCanonicalSearchMatch(section, start, end);
    cursor = end;
  }
}

function* findRegexMatches(
  section: CanonicalSectionText,
  pattern: string,
  matchCase: boolean,
  state: SearchBudgetState,
  runtime: MatchRuntimeOptions,
): Generator<CanonicalSearchMatch, void, void> {
  const regex = compileSafeRegex(pattern, matchCase);
  const now = runtime.now ?? defaultNow;
  const startedAt = now();

  while (true) {
    ensureRegexTime(startedAt, now);
    const match = regex.exec(section.text);
    ensureRegexTime(startedAt, now);
    if (!match) return;

    const value = match[0] ?? '';
    const start = match.index;
    // Zero-width matches are not useful to a reader and must never keep a
    // global regex at the same lastIndex forever.
    if (value.length === 0) {
      regex.lastIndex = advanceStringIndex(section.text, regex.lastIndex, true);
      continue;
    }
    if (state.resultCount >= MAX_REGEX_RESULTS) {
      throw new SearchBudgetError(
        'REGEX_RESULT_LIMIT',
        `正则搜索结果超过上限 ${MAX_REGEX_RESULTS} 条`,
      );
    }
    state.resultCount += 1;
    yield createCanonicalSearchMatch(section, start, start + value.length);
  }
}

/** 编译前的同步安全检查；实际应用搜索在 Worker 中执行以隔离同步回溯。 */
export function compileSafeRegex(pattern: string, matchCase: boolean): RegExp {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new SearchBudgetError(
      'REGEX_TOO_LONG',
      `正则表达式不能超过 ${MAX_REGEX_PATTERN_LENGTH} 个字符`,
    );
  }
  if (hasUnsafeRegexShape(pattern)) {
    throw new SearchBudgetError('REGEX_UNSAFE', '正则表达式包含可能导致失控回溯的结构');
  }
  try {
    return new RegExp(pattern, matchCase ? 'gu' : 'giu');
  } catch {
    throw new SearchBudgetError('INVALID_REGEX', '无效的正则表达式');
  }
}

/** 在 Worker 内使用的正则偏移收集器；不创建 DOM Range。 */
export function collectRegexMatchOffsets(
  text: string,
  pattern: string,
  matchCase: boolean,
): RegexMatchOffset[] {
  if (text.length > MAX_SEARCH_SECTION_CHARACTERS) {
    throw new SearchBudgetError(
      'SEARCH_SECTION_LIMIT',
      `单章节可搜索文本超过 ${MAX_SEARCH_SECTION_CHARACTERS} 个字符`,
    );
  }
  const regex = compileSafeRegex(pattern, matchCase);
  const offsets: RegexMatchOffset[] = [];
  while (true) {
    const match = regex.exec(text);
    if (!match) return offsets;
    const value = match[0] ?? '';
    if (value.length === 0) {
      regex.lastIndex = advanceStringIndex(text, regex.lastIndex, true);
      continue;
    }
    if (offsets.length >= MAX_REGEX_RESULTS) {
      throw new SearchBudgetError(
        'REGEX_RESULT_LIMIT',
        `正则搜索结果超过上限 ${MAX_REGEX_RESULTS} 条`,
      );
    }
    offsets.push({ start: match.index, end: match.index + value.length });
  }
}

/**
 * 在可终止的 Worker 中执行单章节正则。主线程计时器不能中断同步
 * RegExp.exec，因此超时路径必须 terminate Worker，而不是只在 exec 前后
 * 比较时间。
 */
export function findRegexMatchOffsetsInWorker(
  text: string,
  pattern: string,
  matchCase: boolean,
  signal?: AbortSignal,
): Promise<RegexMatchOffset[]> {
  if (signal?.aborted) {
    return Promise.reject(new SearchBudgetError('SEARCH_CANCELLED', '搜索已取消'));
  }
  // 先在调用线程返回可预测的语法/安全错误，再把可能失控的 exec 隔离到 Worker。
  compileSafeRegex(pattern, matchCase);
  if (typeof Worker === 'undefined') {
    return Promise.reject(
      new SearchBudgetError('REGEX_UNAVAILABLE', '当前环境不支持可终止的正则搜索'),
    );
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('./canonicalRegexWorker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    return Promise.reject(
      new SearchBudgetError('REGEX_UNAVAILABLE', '当前环境不支持可终止的正则搜索'),
    );
  }
  return new Promise<RegexMatchOffset[]>((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      finish(new SearchBudgetError('REGEX_TIMEOUT', '正则搜索超过单章节时间预算'));
    }, REGEX_SECTION_TIMEOUT_MS);

    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const finish = (error: SearchBudgetError | null, offsets: RegexMatchOffset[] = []) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(offsets);
    };
    const onAbort = () => finish(new SearchBudgetError('SEARCH_CANCELLED', '搜索已取消'));

    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<{
      type: 'result' | 'error';
      offsets?: RegexMatchOffset[];
      code?: SearchBudgetErrorCode;
      message?: string;
    }>) => {
      if (event.data.type === 'result') {
        finish(null, event.data.offsets ?? []);
      } else {
        finish(
          new SearchBudgetError(
            event.data.code ?? 'REGEX_TIMEOUT',
            event.data.message ?? '正则搜索失败',
          ),
        );
      }
    };
    worker.onerror = () =>
      finish(new SearchBudgetError('REGEX_TIMEOUT', '正则搜索执行失败'));
    worker.postMessage({ text, pattern, matchCase });
  });
}

/** 拒绝常见灾难性回溯形状；时间预算仍是第二道防线。 */
function hasUnsafeRegexShape(pattern: string): boolean {
  if (/(?:\.\*|\.\+)[^\n]*(?:\.\*|\.\+)/.test(pattern)) return true;

  // JavaScript RegExp.exec 是同步的，单次执行无法被外部计时器中断。
  // 因此拒绝所有“带量词/分支的分组再次量化”的形状，而不是只拦截
  // 一个已知样例；这样才不会让调用方通过换写法绕过章节时间预算。
  const groups: RegexGroup[] = [];
  let lastAtom: RegexAtom | null = null;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      if (/[1-9]/.test(pattern[index + 1] ?? '')) return true;
      index += 1;
      lastAtom = {};
      continue;
    }
    if (character === '[') {
      index = skipCharacterClass(pattern, index);
      lastAtom = {};
      continue;
    }
    if (character === '(') {
      if (pattern[index + 1] === '?') {
        // 非捕获分组是安全的；lookaround、命名分组和内联模式不进入
        // 预算搜索，避免引入额外的回溯语义。
        if (pattern[index + 2] !== ':') return true;
        index += 2;
      }
      const group: RegexGroup = { hasAlternation: false, hasQuantifier: false };
      groups.push(group);
      lastAtom = { group };
      continue;
    }
    if (character === ')') {
      const group = groups.pop();
      lastAtom = group ? { group } : null;
      continue;
    }
    if (character === '|') {
      const group = groups.at(-1);
      if (group) group.hasAlternation = true;
      lastAtom = null;
      continue;
    }
    const quantifierEnd = readQuantifierEnd(pattern, index);
    if (quantifierEnd !== null) {
      if (lastAtom?.group && (lastAtom.group.hasAlternation || lastAtom.group.hasQuantifier)) {
        return true;
      }
      const group = groups.at(-1);
      if (group) group.hasQuantifier = true;
      index = quantifierEnd;
      lastAtom = null;
      continue;
    }
    lastAtom = {};
  }
  return false;
}

interface RegexGroup {
  hasAlternation: boolean;
  hasQuantifier: boolean;
}

interface RegexAtom {
  group?: RegexGroup;
}

function skipCharacterClass(pattern: string, start: number): number {
  for (let index = start + 1; index < pattern.length; index += 1) {
    if (pattern[index] === '\\') {
      index += 1;
    } else if (pattern[index] === ']') {
      return index;
    }
  }
  return pattern.length - 1;
}

function readQuantifierEnd(pattern: string, start: number): number | null {
  const character = pattern[start];
  if (character === '*' || character === '+' || character === '?') return start;
  if (character !== '{' || !/\d/.test(pattern[start + 1] ?? '')) return null;
  const end = pattern.indexOf('}', start + 1);
  return end >= 0 && /^\{\d+(?:,\d*)?\}$/.test(pattern.slice(start, end + 1)) ? end : null;
}

function ensureRegexTime(startedAt: number, now: () => number): void {
  if (now() - startedAt > REGEX_SECTION_TIMEOUT_MS) {
    throw new SearchBudgetError('REGEX_TIMEOUT', '正则搜索超过单章节时间预算');
  }
}

export function createCanonicalSearchMatch(
  section: CanonicalSectionText,
  start: number,
  end: number,
): CanonicalSearchMatch {
  const contextStart = Math.max(0, start - CONTEXT_LENGTH);
  const contextEnd = Math.min(section.text.length, end + CONTEXT_LENGTH);
  return {
    start,
    end,
    range: section.range(start, end),
    excerpt: {
      pre: section.text.slice(contextStart, start).trimStart().slice(-CONTEXT_LENGTH),
      match: section.text.slice(start, end),
      post: section.text.slice(end, contextEnd).trimEnd().slice(0, CONTEXT_LENGTH),
    },
  };
}

function isIgnoredTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  return Boolean(
    parent.closest(
      'script,style,noscript,template,[data-ai-reader-display-only],[cfi-inert],[data-cfi-inert]',
    ),
  );
}

function locateBoundary(
  spans: readonly TextSpan[],
  offset: number,
  isEnd: boolean,
): { node: Text; offset: number } {
  for (const span of spans) {
    if (offset < span.end || (isEnd && offset === span.end)) {
      return { node: span.node, offset: offset - span.start };
    }
  }
  const last = spans.at(-1)!;
  return { node: last.node, offset: last.node.length };
}

function advanceStringIndex(value: string, index: number, unicode: boolean): number {
  if (!unicode || index >= value.length) return index + 1;
  const first = value.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
    const second = value.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return index + 2;
  }
  return index + 1;
}

function defaultNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export interface CanonicalSearchIndexKeyInput {
  sourceFingerprint: string;
  canonicalTransformVersion: string;
  queryConfigVersion?: string;
}

export function buildCanonicalSearchIndexKey(input: CanonicalSearchIndexKeyInput): string {
  return [
    'epub-search-index',
    CANONICAL_SEARCH_INDEX_VERSION,
    input.queryConfigVersion ?? CANONICAL_SEARCH_QUERY_CONFIG_VERSION,
    input.canonicalTransformVersion,
    input.sourceFingerprint,
  ]
    .map((value) => encodeURIComponent(value))
    .join(':');
}

export interface CanonicalSearchSectionSnapshot {
  textNodes: string[];
  characterCount: number;
}

export interface CanonicalSearchIndexSnapshot {
  key: string;
  sections: Record<string, CanonicalSearchSectionSnapshot>;
  totalCharacters: number;
}

export interface CanonicalSearchIndexCache {
  get(key: string): CanonicalSearchIndexSnapshot | undefined;
  set(key: string, value: CanonicalSearchIndexSnapshot): void;
}

export function createCanonicalSearchIndexCache(maxEntries = 8): CanonicalSearchIndexCache {
  const values = new Map<string, CanonicalSearchIndexSnapshot>();
  return {
    get(key) {
      const value = values.get(key);
      if (value) {
        values.delete(key);
        values.set(key, value);
      }
      return value;
    },
    set(key, value) {
      values.delete(key);
      values.set(key, value);
      while (values.size > Math.max(1, maxEntries)) {
        const oldest = values.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        values.delete(oldest);
      }
    },
  };
}

export function isUsableCanonicalSearchIndex(
  value: CanonicalSearchIndexSnapshot | undefined,
  key: string,
): value is CanonicalSearchIndexSnapshot {
  if (
    !value ||
    typeof value !== 'object' ||
    value.key !== key ||
    !Number.isSafeInteger(value.totalCharacters) ||
    value.totalCharacters < 0
  ) {
    return false;
  }
  if (!value.sections || typeof value.sections !== 'object') return false;
  const sectionsAreUsable = Object.values(value.sections).every((section) => {
    return (
      !!section &&
      typeof section === 'object' &&
      Array.isArray(section.textNodes) &&
      section.textNodes.every((text) => typeof text === 'string') &&
      Number.isSafeInteger(section.characterCount) &&
      section.characterCount >= 0 &&
      section.characterCount <= MAX_SEARCH_SECTION_CHARACTERS &&
      section.characterCount === section.textNodes.reduce((sum, text) => sum + text.length, 0)
    );
  });
  const total = Object.values(value.sections).reduce(
    (sum, section) => sum + section.characterCount,
    0,
  );
  return (
    sectionsAreUsable &&
    total === value.totalCharacters &&
    total <= MAX_SEARCH_INDEX_CHARACTERS
  );
}

export function addCanonicalSearchSection(
  index: CanonicalSearchIndexSnapshot,
  sectionIndex: number,
  section: CanonicalSectionText,
): CanonicalSearchIndexSnapshot {
  const snapshot: CanonicalSearchSectionSnapshot = {
    textNodes: section.textNodes.map((span) => span.node.nodeValue ?? ''),
    characterCount: section.text.length,
  };
  const previous = index.sections[String(sectionIndex)];
  const totalCharacters = index.totalCharacters - (previous?.characterCount ?? 0) + snapshot.characterCount;
  if (totalCharacters > MAX_SEARCH_INDEX_CHARACTERS) {
    throw new SearchBudgetError(
      'SEARCH_INDEX_LIMIT',
      `全文搜索索引超过 ${MAX_SEARCH_INDEX_CHARACTERS} 个字符`,
    );
  }
  return {
    ...index,
    sections: { ...index.sections, [sectionIndex]: snapshot },
    totalCharacters,
  };
}
