import type { TextAnchor } from './annotation';
import { isSameEpubCfiSpine } from '../reader/epubCfi';

/**
 * 从 DOM Range 构建文本锚点所需的引文与前后文。
 *
 * 选中文字(quote)为 range 的字面文本;前文/后文取引文所在文本节点或段落
 * 上下文中的相邻文字(各至多 CONTEXT_CHARS 个字符),用于文档变化后的唯一
 * 引文匹配。这些都是可序列化字符串,不保存任何 DOM 引用。
 */
export const ANCHOR_CONTEXT_CHARS = 60;

/** 从 Range 中提取选中文字。 */
export function extractQuote(range: Range): string {
  return range.toString();
}

/**
 * 从 Range 提取引文前文/后文上下文。
 * 以 range 的公共祖先容器为上下文文本,取引文字符串前后各至多 CHARS 个字符。
 * 无法定位时返回空字符串。
 */
export function extractContext(
  range: Range,
  chars: number = ANCHOR_CONTEXT_CHARS,
): { before: string; after: string } {
  const quote = extractQuote(range);
  const container = range.commonAncestorContainer;
  const element =
    container && container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
  const text = element?.textContent ?? '';
  const index = text.indexOf(quote);
  if (index < 0) {
    return { before: '', after: '' };
  }
  const before = text.slice(Math.max(0, index - chars), index);
  const after = text.slice(index + quote.length, index + quote.length + chars);
  return { before, after };
}

/**
 * 从 DOM Range 与 CFI 构建一个已解析(resolved)的文本锚点。
 * documentVersion 为材料内容指纹(第一版 EPUB 内容不可变)。
 */
export function buildTextAnchor(
  cfi: string,
  range: Range,
  documentVersion: string,
): TextAnchor {
  const { before, after } = extractContext(range);
  return {
    cfi,
    quote: extractQuote(range),
    before,
    after,
    documentVersion,
    recoveryState: 'resolved',
  };
}

/**
 * 通过「唯一引文匹配」在给定文本中恢复锚点引文在文档中的位置。
 * 返回匹配到的引文(cfi 由调用方结合文档解析);找不到、或出现多次(无法唯一)
 * 时返回 null。
 *
 * ADR-0008:文档变化后先尝试原 CFI,再尝试唯一引文与上下文匹配;无法唯一
 * 恢复时保留批注并标记失联,绝不静默附着到错误位置。
 */
export function findUniqueQuoteMatch(
  text: string,
  anchor: Pick<TextAnchor, 'quote' | 'before' | 'after'>,
): boolean {
  if (!anchor.quote || anchor.quote.length === 0) {
    return false;
  }
  let count = 0;
  let index = text.indexOf(anchor.quote);
  while (index >= 0) {
    count += 1;
    if (count > 1) {
      break;
    }
    index = text.indexOf(anchor.quote, index + anchor.quote.length);
  }
  if (count !== 1) {
    return false;
  }

  // 上下文匹配:若锚点带有前文/后文,则要求引文所在位置的相邻上下文吻合,
  // 从而把「引文唯一但出现在不同上下文」的场景也排除掉。
  const position = text.indexOf(anchor.quote);
  if (anchor.before) {
    const adjacentBefore = text.slice(Math.max(0, position - anchor.before.length), position);
    if (!adjacentBefore.endsWith(anchor.before)) {
      return false;
    }
  }
  if (anchor.after) {
    const adjacentAfter = text.slice(
      position + anchor.quote.length,
      position + anchor.quote.length + anchor.after.length,
    );
    if (!adjacentAfter.startsWith(anchor.after)) {
      return false;
    }
  }
  return true;
}

/** 阅读文档搜索命中中与文本锚点恢复相关的最小数据。 */
export interface TextAnchorSearchMatch {
  cfi: string;
  excerpt: {
    pre: string;
    match: string;
    post: string;
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ');
}

export function textAnchorContextMatches(
  anchor: Pick<TextAnchor, 'before' | 'after'>,
  match: TextAnchorSearchMatch,
): boolean {
  const expectedBefore = normalizeWhitespace(anchor.before).trim();
  const actualBefore = normalizeWhitespace(match.excerpt.pre.replace(/^…/, '')).trim();
  if (expectedBefore && !actualBefore) {
    return false;
  }
  if (expectedBefore && actualBefore) {
    const comparableLength = Math.min(expectedBefore.length, actualBefore.length);
    if (!actualBefore.endsWith(expectedBefore.slice(-comparableLength))) {
      return false;
    }
  }

  const expectedAfter = normalizeWhitespace(anchor.after).trim();
  const actualAfter = normalizeWhitespace(match.excerpt.post.replace(/…$/, '')).trim();
  if (expectedAfter && !actualAfter) {
    return false;
  }
  if (expectedAfter && actualAfter) {
    const comparableLength = Math.min(expectedAfter.length, actualAfter.length);
    if (!actualAfter.startsWith(expectedAfter.slice(0, comparableLength))) {
      return false;
    }
  }
  return true;
}

export type TextAnchorRecoveryReason =
  | 'unique-text'
  | 'zero-matches'
  | 'multiple-matches'
  | 'context-mismatch';

export interface TextAnchorRecoveryEvaluation {
  anchor: TextAnchor;
  outcome: 'resolved' | 'reanchored' | 'orphaned';
  reason: TextAnchorRecoveryReason;
  /** 只统计同一 spine section 且引文文本相同的命中。 */
  matchCount: number;
}

/**
 * 评估一个文本锚点的迁移结果,同时保留零匹配/多匹配信息供显式预览展示。
 * CFI 的 spine 过滤先于唯一性判断,因此恢复永远不会跨章节猜测。
 */
export function evaluateTextAnchorRecovery(
  anchor: TextAnchor,
  documentVersion: string,
  matches: readonly TextAnchorSearchMatch[],
): TextAnchorRecoveryEvaluation {
  const normalizedQuote = normalizeWhitespace(anchor.quote).trim();
  const quoteMatches = matches.filter(
    (match) =>
      isSameEpubCfiSpine(anchor.cfi, match.cfi) &&
      normalizeWhitespace(match.excerpt.match).trim() === normalizedQuote,
  );

  if (quoteMatches.length === 0) {
    return {
      anchor: { ...anchor, recoveryState: 'orphaned' },
      outcome: 'orphaned',
      reason: 'zero-matches',
      matchCount: 0,
    };
  }
  if (quoteMatches.length > 1) {
    return {
      anchor: { ...anchor, recoveryState: 'orphaned' },
      outcome: 'orphaned',
      reason: 'multiple-matches',
      matchCount: quoteMatches.length,
    };
  }
  if (!textAnchorContextMatches(anchor, quoteMatches[0]!)) {
    return {
      anchor: { ...anchor, recoveryState: 'orphaned' },
      outcome: 'orphaned',
      reason: 'context-mismatch',
      matchCount: 1,
    };
  }

  const nextCfi = quoteMatches[0]!.cfi;
  return {
    anchor: {
      ...anchor,
      cfi: nextCfi,
      documentVersion,
      recoveryState: nextCfi === anchor.cfi ? 'resolved' : 'reanchored',
    },
    outcome: nextCfi === anchor.cfi ? 'resolved' : 'reanchored',
    reason: 'unique-text',
    matchCount: 1,
  };
}

/**
 * 根据阅读文档搜索结果迁移文本锚点。
 *
 * 只有引文恰好对应一个搜索命中且前后文吻合时才更新 CFI 与文档版本;
 * 否则保留旧 CFI/版本并标记为失联,让上层继续保留批注而不冒险错配。
 */
export function recoverTextAnchor(
  anchor: TextAnchor,
  documentVersion: string,
  matches: readonly TextAnchorSearchMatch[],
): TextAnchor {
  return evaluateTextAnchorRecovery(anchor, documentVersion, matches).anchor;
}

/**
 * 返回 Range 两端所属的内容文档。
 *
 * 浏览器不允许一个 Range 跨越两个 iframe 文档，但 Selection 事件可能在
 * 章节切换/分页期间短暂留下跨文档的旧状态。提交前仍必须再次验证，避免
 * 把这种活跃 DOM 状态交给 CFI 生成器后产生伪造的单章节范围。
 */
export function getRangeOwnerDocuments(range: Range): {
  start: Document | null;
  end: Document | null;
} {
  return {
    start: ownerDocumentOfNode(range.startContainer),
    end: ownerDocumentOfNode(range.endContainer),
  };
}

function ownerDocumentOfNode(node: Node | null): Document | null {
  if (!node) return null;
  if (node.nodeType === 9) return node as Document;
  return node.ownerDocument;
}

/** 只有两端明确属于同一内容文档时，Range 才能作为单章节批注保存。 */
export function isRangeWithinOneDocument(range: Range): boolean {
  const documents = getRangeOwnerDocuments(range);
  return documents.start !== null && documents.start === documents.end;
}

/**
 * 返回单章节选择校验失败原因；返回 null 表示没有发现跨章节证据。
 * `getDocumentIndex` 由 BookDocument 提供，避免文本锚点子域依赖具体阅读器。
 */
export function getSingleSectionSelectionError(
  range: Range,
  getDocumentIndex: (document: Document) => number | null,
): string | null {
  if (!isRangeWithinOneDocument(range)) {
    return '跨章节选择不能保存为单条批注，请分别选择每个章节。';
  }
  const documents = getRangeOwnerDocuments(range);
  if (!documents.start || !documents.end) {
    return '无法确定选区所属章节，请重新选择正文。';
  }
  const startIndex = getDocumentIndex(documents.start);
  const endIndex = getDocumentIndex(documents.end);
  if (startIndex === null || endIndex === null) {
    return '无法确定选区所属章节，请重新选择正文。';
  }
  if (startIndex !== endIndex) {
    return '跨章节选择不能保存为单条批注，请分别选择每个章节。';
  }
  return null;
}
