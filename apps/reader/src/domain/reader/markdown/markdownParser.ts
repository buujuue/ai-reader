/**
 * Markdown 解析器:把 Markdown 源文本渲染为经过清洗的 HTML 片段,
 * 按一级标题(`#`)分段,并提取来源标题/作者。
 *
 * 这是"Markdown 作为一等阅读材料"的解析承载(ADR-0004 / ADR-0009):
 * 渲染结果一律视为不可信输入,先经 `sanitizeHtmlFragment` 清洗(ADR-0010),
 * 再交给阅读器,确保原始 HTML、脚本、iframe、对象嵌入与危险 URL 不会执行。
 */

import { marked } from 'marked';
import { sanitizeHtmlFragment } from '../sanitizer';

/** 一份 Markdown 的一个章节(按一级标题切分)。`title` 为一节标题文本。 */
export interface MarkdownSection {
  title: string;
  /** 已清洗的 HTML 片段(不含完整文档骨架)。 */
  html: string;
}

/** 解析结果:来源元数据 + 按一级标题切分后的章节。 */
export interface ParsedMarkdown {
  /** 来源标题:优先 frontmatter.title,否则首个一级标题;无则 null(由调用方用文件名兜底)。 */
  title: string | null;
  /** 来源作者:仅来自 frontmatter.author;无则 null。 */
  author: string | null;
  /** 按一级标题切分的章节;开头无一级标题的内容归入首个"前言"章节。 */
  sections: MarkdownSection[];
}

/** frontmatter 简单解析:形如 `---\ntitle: xxx\nauthor: yyy\n---`。 */
export function parseFrontmatter(markdown: string): {
  title: string | null;
  author: string | null;
  rest: string;
} {
  const trimmed = markdown.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) {
    return { title: null, author: null, rest: trimmed };
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) {
    return { title: null, author: null, rest: trimmed };
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
  if (endIndex < 0) {
    return { title: null, author: null, rest: trimmed };
  }
  const header = lines.slice(1, endIndex);
  const title = pickFrontmatterValue(header, 'title');
  const author = pickFrontmatterValue(header, 'author');
  return {
    title,
    author,
    rest: lines.slice(endIndex + 1).join('\n'),
  };
}

function pickFrontmatterValue(lines: string[], key: string): string | null {
  const prefix = `${key}:`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      continue;
    }
    const value = trimmed.slice(prefix.length).trim().replace(/^["']|["']$/g, '');
    if (!value) {
      return null;
    }
    return value;
  }
  return null;
}

/**
 * 解析 Markdown:渲染 → 清洗 → 按一级标题切分。
 * 本函数只负责文档结构;搜索参数等由上层另行处理。
 */
export function parseMarkdown(markdown: string): ParsedMarkdown {
  const { title: frontmatterTitle, author, rest } = parseFrontmatter(markdown);
  const html = marked.parse(rest, { async: false, gfm: true, breaks: false });
  const fragment = sanitizeHtmlFragment(html);
  const fragmentWithHeadingIds = addHeadingIds(fragment);

  const doc = new DOMParser().parseFromString(`<body>${fragmentWithHeadingIds}</body>`, 'text/html');
  const body = doc.body;

  let firstHeadingTitle: string | null = null;
  const sections: MarkdownSection[] = [];
  // 当前章节的标题(首个一级标题文本)与内容节点。
  let currentTitle = '';
  let current: HTMLElement[] = [];

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const container = doc.createElement('div');
    for (const node of current) {
      container.appendChild(node);
    }
    sections.push({ title: currentTitle, html: container.innerHTML });
    current = [];
  };

  const children = Array.from(body.children);
  for (const child of children) {
    if (child.tagName === 'H1') {
      flush();
      const label = child.textContent?.trim() ?? '';
      if (firstHeadingTitle === null) {
        firstHeadingTitle = label;
      }
      currentTitle = label;
      current.push(child as HTMLElement);
    } else {
      current.push(child as HTMLElement);
    }
  }
  flush();

  // 若文档没有一级标题,整篇作为单个章节(标题回落到文件名兜底)。
  const title = frontmatterTitle ?? firstHeadingTitle;

  if (sections.length === 0) {
    sections.push({ title: frontmatterTitle ?? '', html: fragmentWithHeadingIds });
  }

  return { title, author, sections };
}

/** 把标题文本转成 ASCII slug(与 marked 的 GFM 标题锚点惯例一致)。 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    || 'section';
}

/**
 * 为清洗后的 HTML 片段中的每个标题补上稳定的 slug id,
 * 使 `[链接](#标题)` 式 Markdown 内部锚点可解析(GFM 惯例)。
 * 在 DOM 上原地补 id,不改变标题内容。
 */
function addHeadingIds(fragment: string): string {
  const doc = new DOMParser().parseFromString(`<body>${fragment}</body>`, 'text/html');
  const seen = new Map<string, number>();
  for (const heading of Array.from(doc.body.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    const base = slugify(heading.textContent ?? '');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heading.setAttribute('id', count === 0 ? base : `${base}-${count + 1}`);
  }
  return doc.body.innerHTML;
}