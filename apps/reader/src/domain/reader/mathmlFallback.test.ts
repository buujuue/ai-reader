import { describe, expect, it, vi } from 'vitest';

import { degradeUnsupportedMathMl } from './mathmlFallback';

describe('MathML 局部降级', () => {
  it('公式没有可见布局时替换为可理解的文本,不影响同章其它正文', () => {
    const doc = document.implementation.createHTMLDocument('math');
    doc.body.innerHTML = '<p>前文</p><math><mi>x</mi><mo>=</mo><mn>1</mn></math><p>后文</p>';
    const math = doc.querySelector('math');
    expect(math).not.toBeNull();
    vi.spyOn(math!, 'getBoundingClientRect').mockReturnValue({
      width: 0,
      height: 0,
    } as DOMRect);

    expect(degradeUnsupportedMathMl(doc)).toBe(1);
    expect(doc.body.textContent).toContain('前文');
    expect(doc.body.textContent).toContain('公式：x=1');
    expect(doc.body.textContent).toContain('后文');
    expect(doc.querySelector('.ai-reader-math-fallback')?.getAttribute('aria-label')).toBe(
      '公式：x=1',
    );
  });

  it('公式有可见布局时保留原始 MathML', () => {
    const doc = document.implementation.createHTMLDocument('math');
    doc.body.innerHTML = '<math><mi>x</mi></math>';
    const math = doc.querySelector('math');
    expect(math).not.toBeNull();
    vi.spyOn(math!, 'getBoundingClientRect').mockReturnValue({
      width: 12,
      height: 12,
    } as DOMRect);

    expect(degradeUnsupportedMathMl(doc)).toBe(0);
    expect(doc.querySelector('math')).not.toBeNull();
  });
});
