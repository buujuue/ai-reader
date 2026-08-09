import { describe, expect, it } from 'vitest';

import { parseFrontmatter, parseMarkdown } from './markdownParser';

describe('parseFrontmatter', () => {
  it('提取 title 与 author 并返回正文', () => {
    const { title, author, rest } = parseFrontmatter('---\ntitle: 我的笔记\nauthor: 用户\n---\n# 正文');
    expect(title).toBe('我的笔记');
    expect(author).toBe('用户');
    expect(rest).toContain('# 正文');
  });

  it('无 frontmatter 时返回空元数据与原文', () => {
    const { title, author, rest } = parseFrontmatter('# 只有标题');
    expect(title).toBeNull();
    expect(author).toBeNull();
    expect(rest).toBe('# 只有标题');
  });

  it('frontmatter 未闭合时按普通正文处理', () => {
    const { title, rest } = parseFrontmatter('---\ntitle: 未闭合');
    expect(title).toBeNull();
    expect(rest).toContain('title: 未闭合');
  });

  it('只支持拟定的键,其余行忽略', () => {
    const { title, author } = parseFrontmatter('---\nfoo: 1\ntitle: 标题\n---\n正文');
    expect(title).toBe('标题');
    expect(author).toBeNull();
  });
});

describe('parseMarkdown', () => {
  it('按一级标题切分章节并形成标题', () => {
    const parsed = parseMarkdown('# 第一章\n\ncontent one\n\n# 第二章\n\ncontent two');
    expect(parsed.sections.map((section) => section.title)).toEqual(['第一章', '第二章']);
    expect(parsed.sections[0]!.html).toContain('content one');
    expect(parsed.sections[1]!.html).toContain('content two');
  });

  it('标题优先取 frontmatter.title,否则取首个一级标题', () => {
    expect(parseMarkdown('---\ntitle: 元数据标题\n---\n# 一级标题').title).toBe('元数据标题');
    expect(parseMarkdown('# 一级标题').title).toBe('一级标题');
  });

  it('无一级标题时整篇作为单个章节,title 为 null', () => {
    const parsed = parseMarkdown('普通段落,没有标题');
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.title).toBeNull();
  });

  it('清洗原始没清洗的 HTML:移除脚本与危险链接', () => {
    const parsed = parseMarkdown(
      '<script>alert(1)</script>\n\n# 标题\n\n<a href="javascript:x">坏</a>',
    );
    const joined = parsed.sections.map((section) => section.html).join('');
    expect(joined).not.toContain('<script');
    expect(joined).not.toContain('javascript:');
    expect(parsed.title).toBe('标题');
  });

  it('清洗 iframe 对象嵌入与事件处理器', () => {
    const parsed = parseMarkdown(
      '# 标题\n\n<iframe src="https://evil"></iframe>\n\n<img src="x" onerror="fetch(1)">',
    );
    const joined = parsed.sections.map((section) => section.html).join('');
    expect(joined).not.toContain('iframe');
    expect(joined).not.toContain('onerror');
  });

  it('保留合法的相对与片段链接', () => {
    const parsed = parseMarkdown('# 标题\n\n[下一节](#sec2)');
    const joined = parsed.sections.map((section) => section.html).join('');
    expect(joined).toContain('#sec2');
  });

  it('为标题生成 slug id,使内部锚点可解析', () => {
    const parsed = parseMarkdown('# 我的标题\n\n## 小节\n\n[跳到小节](#小节)');
    const joined = parsed.sections.map((section) => section.html).join('');
    expect(joined).toContain('id="我的标题"');
    expect(joined).toContain('id="小节"');
    // 链接 href 会被标记为 URL 编码,但目标 id 已存在,浏览器可据此解析锚点。
    expect(joined).toContain('href="#%E5%B0%8F%E8%8A%82"');
  });

  it('frontmatter 不进入章节正文', () => {
    const parsed = parseMarkdown('---\ntitle: 标题\n---\n# 一级\n\n正文');
    const joined = parsed.sections.map((section) => section.html).join('');
    expect(joined).not.toContain('title:');
  });
});