import { describe, expect, it } from 'vitest';

import { buildLargePdfFixture } from './pdfFixtures';

describe('大型 PDF 性能夹具', () => {
  it('生成确定性的 600+ 页结构型 PDF,每页都有被页面引用的内容流', () => {
    const options = { pageCount: 640, contentBytesPerPage: 16 * 1024 };
    const first = buildLargePdfFixture(options);
    const second = buildLargePdfFixture(options);
    const text = new TextDecoder().decode(first);

    expect(first).toEqual(second);
    expect(first.byteLength).toBeGreaterThan(8 * 1024 * 1024);
    expect(text).toContain('/Count 640');
    expect(text).toContain('/Contents 643 0 R');
    expect(text).toContain('AI Reader performance page 640');
    expect(text.match(/\/Type \/Page\b/g)).toHaveLength(640);
    expect(text.match(/\/Length 16384/g)).toHaveLength(640);
  }, 60_000);
});
