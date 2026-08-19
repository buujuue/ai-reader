/**
 * MathML 的局部降级。
 *
 * 不预先把 MathML 转成图片或文本：支持 MathML 的 WebView 应保留原始公式。
 * 只有公式节点在已加载内容文档中没有可见布局时，才替换成可理解的文本，
 * 让章节其它正文继续可读。
 */
export function degradeUnsupportedMathMl(doc: Document): number {
  const mathElements = Array.from(doc.querySelectorAll('math'));
  let degraded = 0;
  for (const math of mathElements) {
    const rect = math.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) continue;

    const text = math.textContent?.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const fallback = doc.createElement('span');
    fallback.className = 'ai-reader-math-fallback';
    fallback.setAttribute('role', 'img');
    fallback.setAttribute('aria-label', `公式：${text}`);
    fallback.textContent = `公式：${text}`;
    math.replaceWith(fallback);
    degraded += 1;
  }
  return degraded;
}
