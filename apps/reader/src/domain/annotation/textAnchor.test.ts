import { describe, expect, it } from 'vitest';

import {
  buildTextAnchor,
  extractContext,
  findUniqueQuoteMatch,
  getRangeOwnerDocuments,
  getSingleSectionSelectionError,
  isRangeWithinOneDocument,
  recoverTextAnchor,
} from './textAnchor';

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

  it('只有 Range 两端属于同一内容文档时才允许作为单章节选择', () => {
    const first = document.createElement('p');
    first.textContent = '第一节';
    const second = document.createElement('p');
    second.textContent = '第二节';
    document.body.append(first, second);

    const range = document.createRange();
    const firstText = first.firstChild!;
    const secondText = second.firstChild!;
    range.setStart(firstText, 0);
    range.setEnd(secondText, 2);

    const documents = getRangeOwnerDocuments(range);
    expect(documents.start).toBe(document);
    expect(documents.end).toBe(document);
    expect(isRangeWithinOneDocument(range)).toBe(true);

    first.remove();
    second.remove();
  });

  it('Range 两端属于不同内容文档时拒绝保存为单条批注', () => {
    const otherDocument = document.implementation.createHTMLDocument('other');
    const range = {
      startContainer: document.createTextNode('第一节'),
      endContainer: otherDocument.createTextNode('第二节'),
    } as unknown as Range;

    expect(getSingleSectionSelectionError(range, () => 0)).toBe(
      '跨章节选择不能保存为单条批注，请分别选择每个章节。',
    );
  });

  it('无法映射 spine section 时拒绝保存选区', () => {
    const textNode = document.createTextNode('正文');
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 2);

    expect(getSingleSectionSelectionError(range, () => null)).toBe(
      '无法确定选区所属章节，请重新选择正文。',
    );
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

  it('唯一搜索命中且上下文吻合时迁移到新文档版本', () => {
    const anchor = {
      cfi: 'epubcfi(/6/1)!/4/2:0',
      quote: '引文',
      before: '前文',
      after: '后文',
      documentVersion: 'old-version',
      recoveryState: 'resolved' as const,
    };

    expect(
      recoverTextAnchor(anchor, 'new-version', [
        {
          cfi: 'epubcfi(/6/1)!/4/4:0',
          excerpt: { pre: '新的前文', match: '引文', post: '后文内容' },
        },
      ]),
    ).toEqual({
      ...anchor,
      cfi: 'epubcfi(/6/1)!/4/4:0',
      documentVersion: 'new-version',
      recoveryState: 'reanchored',
    });
  });

  it('唯一引文位于其它 spine 章节时保留为失联', () => {
    const anchor = {
      cfi: 'epubcfi(/6/1)!/4/2:0',
      quote: '引文',
      before: '前文',
      after: '后文',
      documentVersion: 'old-version',
      recoveryState: 'resolved' as const,
    };

    expect(
      recoverTextAnchor(anchor, 'new-version', [
        {
          cfi: 'epubcfi(/6/2)!/4/4:0',
          excerpt: { pre: '新的前文', match: '引文', post: '后文内容' },
        },
      ]),
    ).toEqual({ ...anchor, recoveryState: 'orphaned' });
  });

  it('搜索命中不唯一时保留旧锚点并标记为失联', () => {
    const anchor = {
      cfi: 'epubcfi(/6/1)!/4/2:0',
      quote: '重复引文',
      before: '',
      after: '',
      documentVersion: 'old-version',
      recoveryState: 'resolved' as const,
    };

    expect(
      recoverTextAnchor(anchor, 'new-version', [
        { cfi: 'epubcfi(/6/2)!/4/2:0', excerpt: { pre: '', match: '重复引文', post: '' } },
        { cfi: 'epubcfi(/6/3)!/4/2:0', excerpt: { pre: '', match: '重复引文', post: '' } },
      ]),
    ).toEqual({ ...anchor, recoveryState: 'orphaned' });
  });

  it('搜索结果缺少锚点上下文时标记为失联', () => {
    const anchor = {
      cfi: 'epubcfi(/6/1)!/4/2:0',
      quote: '引文',
      before: '前文',
      after: '后文',
      documentVersion: 'old-version',
      recoveryState: 'resolved' as const,
    };

    expect(
      recoverTextAnchor(anchor, 'new-version', [
        { cfi: 'epubcfi(/6/2)!/4/4:0', excerpt: { pre: '', match: '引文', post: '' } },
      ]),
    ).toEqual({ ...anchor, recoveryState: 'orphaned' });
  });
});
