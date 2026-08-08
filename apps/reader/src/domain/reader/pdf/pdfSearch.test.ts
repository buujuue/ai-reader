import { describe, expect, it, vi } from 'vitest';

import { searchPdf } from './pdfSearch';
import { makeFakeDocument, makeFakeLib, makeFakePage } from './pdfTestFakes';
import { decodePdfTextAnchor } from './pdfTextAnchor';

describe('searchPdf PDF 文本搜索', () => {
  it('逐页增量产出进度并返回带页码/归一化矩形的命中', async () => {
    const page1 = makeFakePage({ width: 100, height: 200 }, [
      { str: '你好世界', transform: [10, 0, 0, 10, 10, 150], width: 40 },
    ]);
    const page2 = makeFakePage({ width: 100, height: 200 }, [
      { str: '搜索世界', transform: [10, 0, 0, 10, 10, 150], width: 40 },
    ]);
    const document = makeFakeDocument(2);
    (document.getPage as ReturnType<typeof vi.fn>).mockImplementation(async (n: number) =>
      n === 1 ? page1 : page2,
    );
    makeFakeLib(document);

    const events: Array<{ kind: string; page?: number | undefined }> = [];
    for await (const event of searchPdf(document, { query: '世界', matchCase: false })) {
      if (event.kind === 'progress') {
        events.push({ kind: 'progress' });
      } else {
        events.push({ kind: 'match', page: decodePdfTextAnchor(event.match.cfi)?.page });
      }
    }

    expect(events).toEqual([
      { kind: 'progress' },
      { kind: 'match', page: 1 },
      { kind: 'progress' },
      { kind: 'match', page: 2 },
      { kind: 'progress' },
    ]);
  });

  it('命中锚点可解码回页码与归一化矩形', async () => {
    const page = makeFakePage({ width: 100, height: 200 }, [
      { str: '关键词出现', transform: [10, 0, 0, 10, 20, 30], width: 50 },
    ]);
    const document = makeFakeDocument(1);
    (document.getPage as ReturnType<typeof vi.fn>).mockResolvedValue(page);
    makeFakeLib(document);

    let cfi = '';
    for await (const event of searchPdf(document, { query: '关键词', matchCase: false })) {
      if (event.kind === 'match') cfi = event.match.cfi;
    }

    const loc = decodePdfTextAnchor(cfi);
    expect(loc?.page).toBe(1);
    expect(loc?.rect).toBeDefined();
    expect(loc!.rect.x).toBeGreaterThanOrEqual(0);
    expect(loc!.rect.x).toBeLessThanOrEqual(1);
  });

  it('扫描页无文字层时不产出伪造命中', async () => {
    const page = makeFakePage({ width: 100, height: 200 }, []);
    const document = makeFakeDocument(1);
    (document.getPage as ReturnType<typeof vi.fn>).mockResolvedValue(page);
    makeFakeLib(document);

    const events: string[] = [];
    for await (const event of searchPdf(document, { query: '任何', matchCase: false })) {
      events.push(event.kind);
    }
    expect(events).toEqual(['progress', 'progress']);
  });

  it('区分大小写开关影响命中', async () => {
    const page = makeFakePage({ width: 100, height: 100 }, [
      { str: 'Find find', transform: [10, 0, 0, 10, 0, 0], width: 40 },
    ]);
    const document = makeFakeDocument(1);
    (document.getPage as ReturnType<typeof vi.fn>).mockResolvedValue(page);
    makeFakeLib(document);

    let caseSensitiveCount = 0;
    for await (const event of searchPdf(document, { query: 'Find', matchCase: true })) {
      if (event.kind === 'match') caseSensitiveCount += 1;
    }
    expect(caseSensitiveCount).toBe(1);
  });

  it('空查询不产出任何事件', async () => {
    const document = makeFakeDocument(1);
    makeFakeLib(document);
    const events: unknown[] = [];
    for await (const event of searchPdf(document, { query: '   ' })) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });

  it('搜索可取消:return() 后不再产出后续事件', async () => {
    const pageWithHit = makeFakePage({ width: 100, height: 100 }, [
      { str: '关键词', transform: [10, 0, 0, 10, 0, 0], width: 30 },
    ]);
    const document = makeFakeDocument(10);
    (document.getPage as ReturnType<typeof vi.fn>).mockResolvedValue(pageWithHit);
    makeFakeLib(document);

    const generator = searchPdf(document, { query: '关键词', matchCase: false });
    const events: string[] = [];
    for await (const event of generator) {
      events.push(event.kind);
      // 收到第一个命中后立即取消,后续页码不应再被读取。
      if (event.kind === 'match') {
        await generator.return(undefined);
      }
    }
    expect(events).toContain('match');
    // 取消后不应再产出更多进度事件。
    expect(events.filter((k) => k === 'progress')).toHaveLength(1);
  });
});