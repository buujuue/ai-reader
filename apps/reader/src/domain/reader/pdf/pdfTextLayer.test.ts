import { describe, expect, it } from 'vitest';

import { buildPdfTextLayer, layoutTextSpan } from './pdfTextLayer';

const PAGE = { width: 595, height: 842 };

describe('layoutTextSpan 文本项定位', () => {
  it('把 transform 的基线原点缩放到显示坐标,并翻转 PDF 的向上 y', () => {
    // scale=2:left = e*2,page 高度*s - f*2 - ascent*2。
    const layout = layoutTextSpan(
      { str: 'Hello', transform: [10, 0, 0, 10, 100, 700], width: 50 },
      PAGE,
      2,
    );
    // 字号 10 → ascent 8 → top = 842*2 - 700*2 - 8*2 = 1684-1400-16。left=100*2=200
    expect(layout.left).toBeCloseTo(200);
    expect(layout.top).toBeCloseTo(268);
    expect(layout.width).toBeCloseTo(100);
    expect(layout.height).toBeCloseTo(20);
  });

  it('无 transform 时按恒等变换处理(原点在左上/基线 0)', () => {
    const layout = layoutTextSpan({ str: 'x', width: 10 }, PAGE, 1);
    expect(layout.left).toBe(0);
    // top = height - 0 - ascent(1*0.8) = 842 - 0.8
    expect(layout.top).toBeCloseTo(PAGE.height - 0.8);
  });
});

describe('buildPdfTextLayer 构建对齐文本层', () => {
  it('每个有内容的项生成一个绝对定位 span,返回其几何', () => {
    const pageElement = document.createElement('div');
    const spans = buildPdfTextLayer({
      pageElement,
      items: [
        { str: '示例', transform: [12, 0, 0, 12, 200, 300], width: 48 },
        { str: '', transform: [12, 0, 0, 12, 0, 0] },
        { str: '第二行', transform: [12, 0, 0, 12, 200, 320], width: 48, hasEOL: true },
      ],
      pageDims: PAGE,
      scale: 1,
    });

    expect(spans).toHaveLength(2);
    const spansEl = pageElement.querySelectorAll('span.pdf-text-span');
    expect(spansEl).toHaveLength(2);
    expect(pageElement.querySelectorAll('span.pdf-text-span')[0]?.textContent).toBe('示例');
    expect(spansEl[0]).toBeInstanceOf(HTMLSpanElement);
    expect((spansEl[0] as HTMLSpanElement).style.position).toBe('absolute');
    expect(spans[0]!.left).toBeCloseTo(200);
  });

  it('全部为空项时返回空数组(扫描页无文字层)', () => {
    const pageElement = document.createElement('div');
    const spans = buildPdfTextLayer({
      pageElement,
      items: [{ str: '' }, { str: '' }],
      pageDims: PAGE,
      scale: 1,
    });
    expect(spans).toHaveLength(0);
    expect(pageElement.querySelectorAll('span.pdf-text-span')).toHaveLength(0);
  });
});