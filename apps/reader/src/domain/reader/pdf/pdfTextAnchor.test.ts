import { describe, expect, it } from 'vitest';

import {
  decodePdfTextAnchor,
  encodePdfTextAnchor,
  isPdfTextAnchor,
  normalizeRectFromRangeRect,
  normalizeRectFromPoints,
} from './pdfTextAnchor';

describe('encodePdfTextAnchor / decodePdfTextAnchor', () => {
  it('往返稳定:编码后能解码回页码与归一化矩形', () => {
    const value = encodePdfTextAnchor({ page: 3, rect: { x: 0.25, y: 0.5, width: 0.4, height: 0.1 } });
    expect(value.startsWith('pdf-text:')).toBe(true);
    const loc = decodePdfTextAnchor(value);
    expect(loc?.page).toBe(3);
    expect(loc?.rect.x).toBeCloseTo(0.25, 5);
    expect(loc?.rect.y).toBeCloseTo(0.5, 5);
    expect(loc?.rect.width).toBeCloseTo(0.4, 5);
    expect(loc?.rect.height).toBeCloseTo(0.1, 5);
  });

  it('矩形分量被夹到 0..1', () => {
    const value = encodePdfTextAnchor({ page: 1, rect: { x: -1, y: 2, width: 3, height: -0.5 } });
    const loc = decodePdfTextAnchor(value);
    expect(loc?.rect.x).toBe(0);
    expect(loc?.rect.y).toBe(1);
    expect(loc?.rect.width).toBe(1);
    expect(loc?.rect.height).toBe(0);
  });

  it('非 PDF 锚点或损坏字符串返回 null', () => {
    expect(decodePdfTextAnchor('epubcfi(/6/1)')).toBeNull();
    expect(decodePdfTextAnchor('pdf-text:abc:1:2:3')).toBeNull();
    expect(decodePdfTextAnchor('pdf-text:0:1:2:3:4')).toBeNull();
    expect(decodePdfTextAnchor('pdf-text:')).toBeNull();
  });

  it('isPdfTextAnchor 识别 PDF 文本锚点', () => {
    expect(isPdfTextAnchor(encodePdfTextAnchor({ page: 1, rect: { x: 0, y: 0, width: 0, height: 0 } }))).toBe(true);
    expect(isPdfTextAnchor('epubcfi(/6/1)')).toBe(false);
  });
});

describe('normalizeRectFromPoints', () => {
  it('支持反向拖拽并把区域限制在页面边界内', () => {
    const rect = normalizeRectFromPoints(
      { x: 180, y: 160 },
      { x: 40, y: 20 },
      { left: 100, top: 100, width: 200, height: 100 },
    );

    expect(rect).toEqual({ x: 0, y: 0, width: 0.4, height: 0.6 });
  });

  it('页面没有尺寸时返回 null', () => {
    expect(
      normalizeRectFromPoints(
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { left: 0, top: 0, width: 0, height: 100 },
      ),
    ).toBeNull();
  });
});

describe('normalizeRectFromRangeRect', () => {
  it('把 Range 矩形换算成页面内归一化矩形', () => {
    const norm = normalizeRectFromRangeRect(
      { left: 200, top: 100, width: 50, height: 20 },
      { left: 100, top: 50, width: 500, height: 200 },
    );
    expect(norm?.x).toBeCloseTo(0.2);
    expect(norm?.y).toBeCloseTo(0.25);
    expect(norm?.width).toBeCloseTo(0.1);
    expect(norm?.height).toBeCloseTo(0.1);
  });

  it('页面尺寸为零时返回 null', () => {
    expect(
      normalizeRectFromRangeRect(
        { left: 0, top: 0, width: 10, height: 10 },
        { left: 0, top: 0, width: 0, height: 0 },
      ),
    ).toBeNull();
  });
});
