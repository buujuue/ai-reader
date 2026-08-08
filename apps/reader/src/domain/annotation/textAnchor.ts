import type { TextAnchor } from './annotation';

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