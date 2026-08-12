import { describe, expect, it } from 'vitest';

import { sanitizeEpubContent, sanitizeHtmlFragment } from './sanitizer';
import {
  MALICIOUS_EPUB_XHTML,
  MALICIOUS_MARKDOWN,
} from '../../test/fixtures/maliciousContent';
import { parseMarkdown } from './markdown/markdownParser';

describe('恶意阅读材料夹具', () => {
  it('EPUB XHTML 夹具不会执行脚本、嵌入对象或危险链接', () => {
    const output = sanitizeEpubContent(MALICIOUS_EPUB_XHTML);

    expect(output).not.toContain('__bookPayload');
    expect(output).not.toMatch(/<(?:iframe|object|embed)\b/i);
    expect(output).not.toMatch(/\bon(?:load|error)=/i);
    expect(output).not.toContain('javascript:');
    expect(output).not.toContain('//evil.example');
    expect(output).not.toContain('https://evil.example/remote');
    expect(output).toContain('应保留的 EPUB 正文');
  });

  it('Markdown 夹具经过 HTML 清洗后只保留安全正文', () => {
    const output = parseMarkdown(MALICIOUS_MARKDOWN)
      .sections.map((section) => section.html)
      .join('\n');

    expect(output).not.toContain('__markdownPayload');
    expect(output).not.toMatch(/<(?:iframe|object)\b/i);
    expect(output).not.toMatch(/\bonerror=/i);
    expect(output).not.toContain('javascript:');
    expect(output).not.toContain('//evil.example');
    expect(output).not.toContain('https://evil.example/remote');
    expect(output).toContain('正文应保留。');
  });
});

describe('sanitizeEpubContent', () => {
  it('移除 script 元素及其内容', () => {
    const input = `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><p>正文</p><script>alert(1)</script></body></html>`;

    const output = sanitizeEpubContent(input);

    expect(output).not.toContain('<script');
    expect(output).not.toContain('alert(1)');
    expect(output).toContain('正文');
  });

  it('移除 iframe、object 与 embed 嵌入', () => {
    const input = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <iframe src="https://evil.example/x"></iframe>
      <object data="https://evil.example/y"></object>
      <embed src="https://evil.example/z"></embed>
      <p>保留内容</p>
    </body></html>`;

    const output = sanitizeEpubContent(input);

    expect(output).not.toContain('iframe');
    expect(output).not.toContain('object');
    expect(output).not.toContain('embed');
    expect(output).toContain('保留内容');
  });

  it('移除 javascript: 危险链接', () => {
    const input = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <a href="javascript:alert(1)">危险</a>
      <a href="https://safe.example">安全</a>
    </body></html>`;

    const output = sanitizeEpubContent(input);

    expect(output).not.toContain('javascript:');
    expect(output).toContain('https://safe.example');
  });

  it('移除远程图片和外部样式表,但保留交给系统浏览器的外链', () => {
    const input = `<link rel="stylesheet" href="https://evil.example/book.css"><img src="https://evil.example/book.png"><a href="https://safe.example">安全</a>`;

    const output = sanitizeHtmlFragment(input);

    expect(output).not.toContain('evil.example');
    expect(output).toContain('https://safe.example');
  });

  it('移除事件处理器属性', () => {
    const input = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <p onclick="alert(1)">文本</p>
      <img src="x.png" onerror="fetch('https://evil')">
    </body></html>`;

    const output = sanitizeEpubContent(input);

    expect(output).not.toContain('onclick');
    expect(output).not.toContain('onerror');
  });

  it('移除 srcdoc 与危险 data 脚本 URL', () => {
    const input = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <iframe srcdoc="<script>alert(1)</script>"></iframe>
      <img src="data:text/html;base64,PHNjcmlwdD4=">
      <img src="data:image/png;base64,AAAA">
    </body></html>`;

    const output = sanitizeEpubContent(input);

    expect(output).not.toContain('srcdoc');
    expect(output).not.toContain('data:text/html');
    expect(output).toContain('data:image/png');
  });

  it('保留合法的相对与片段链接', () => {
    const input = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
      <a href="chapter2.xhtml">下一章</a>
      <a href="#sec1">锚点</a>
    </body></html>`;

    const output = sanitizeEpubContent(input);

    expect(output).toContain('chapter2.xhtml');
    expect(output).toContain('#sec1');
  });
});

describe('sanitizeHtmlFragment', () => {
  it('清洗脚本、iframe、对象嵌入与事件处理器属性', () => {
    const input = `<p>正文</p><script>alert(1)</script><iframe src="x"></iframe><img src="y" onerror="fetch(1)">`;

    const output = sanitizeHtmlFragment(input);

    expect(output).not.toContain('<script');
    expect(output).not.toContain('iframe');
    expect(output).not.toContain('onerror');
    expect(output).toContain('正文');
  });

  it('移除危险 URL 并保留合法链接', () => {
    const input = `<a href="javascript:alert(1)">坏</a><a href="https://safe.example">好</a><a href="#sec">锚</a>`;

    const output = sanitizeHtmlFragment(input);

    expect(output).not.toContain('javascript:');
    expect(output).toContain('https://safe.example');
    expect(output).toContain('#sec');
  });

  it('拒绝协议相对 URL(//,网络路径引用)', () => {
    const input = `<a href="//evil.example/x">坏</a><img src="//evil.example/img.png">`;

    const output = sanitizeHtmlFragment(input);

    expect(output).not.toContain('//evil.example');
  });
});
