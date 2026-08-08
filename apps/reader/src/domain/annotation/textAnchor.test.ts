import { describe, expect, it } from 'vitest';

import { buildTextAnchor, extractContext, findUniqueQuoteMatch } from './textAnchor';

function makeRange(container: HTMLElement, quote: string): Range {
  // 在文本节点中定位引文,构造一个恰好框住引文的 Range。
  const textNode = [...container.childNodes].find(
    (node) => node.nodeType === Node.TEXT_NODE,
  ) as Text | undefined;
  if (!textNode) {
    throw new Error('container 需要包含文本节点');
  }
  const index = textNode.data.indexOf(quote);
  if (index < 0) {
    throw new Error(`未找到引文:${quote}`);
  }
  const range = container.ownerDocument!.createRange();
  range.setStart(textNode, index);
  range.setEnd(textNode, index + quote.length);
  return range;
}

describe('文本锚点构建', () => {
  it('从 Range 提取选中文字作为引文', () => {
    const container = document.createElement('p');
    container.textContent = '这是前文，被选中的文字在这里。';
    document.body.appendChild(container);
    const range = makeRange(container, '被选中的文字');

    const anchor = buildTextAnchor('epubcfi(/6/1)', range, 'fingerprint-1');

    expect(anchor.cfi).toBe('epubcfi(/6/1)');
    expect(anchor.quote).toBe('被选中的文字');
    expect(anchor.recoveryState).toBe('resolved');
    expect(anchor.documentVersion).toBe('fingerprint-1');
    document.body.removeChild(container);
  });

  it('提取引文前后文上下文文字', () => {
    const container = document.createElement('p');
    container.textContent = '这是前文，被选中的文字在这里。';
    document.body.appendChild(container);
    const range = makeRange(container, '被选中的文字');

    const { before, after } = extractContext(range);

    expect(before).toContain('这是前文');
    expect(after).toContain('在这里');
    document.body.removeChild(container);
  });

  it('罕见情况下拿不到上下文时返回空字符串', () => {
    const container = document.createElement('p');
    container.textContent = 'abc';
    document.body.appendChild(container);
    const range = makeRange(container, 'b');

    const { before, after } = extractContext(range);

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    document.body.removeChild(container);
  });

  it('引文在文本中唯一出现时视为唯一匹配', () => {
    const text = '一段文字，这里有一处引文，后面还有内容。';

    expect(findUniqueQuoteMatch(text, { quote: '这里有一处引文', before: '，', after: '，' })).toBe(true);
  });

  it('引文出现多次时无法唯一恢复,返回 false', () => {
    const text = '重复 重复 重复';

    expect(findUniqueQuoteMatch(text, { quote: '重复', before: '', after: '' })).toBe(false);
  });

  it('引文唯一但上下文不吻合时无法恢复', () => {
    const text = '甲前文 引文 甲后文，乙前文 引文 乙后文';
    // 引文出现两次,上下文不同。
    expect(findUniqueQuoteMatch(text, { quote: '引文', before: '甲前文', after: '甲后文' })).toBe(false);
  });
});