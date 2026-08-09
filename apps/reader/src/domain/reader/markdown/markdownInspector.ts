import type { SourceMetadata } from '../../library/material';
import { parseMarkdown } from './markdownParser';

/** 检查失败的领域化分类,前端据此展示可行动的简体中文文案。 */
export type MarkdownInspectErrorKind = 'empty' | 'unsupported' | 'corrupt';

/** 领域化错误:文件为空、不是受支持格式或结构不可读时抛出。 */
export class MarkdownInspectError extends Error {
  override name = 'MarkdownInspectError';
  constructor(
    message: string,
    readonly kind: MarkdownInspectErrorKind,
  ) {
    super(message);
  }
}

export interface MarkdownInspectResult {
  metadata: SourceMetadata;
}

/** 把源文件名转成可理解的标题兜底(去扩展名、下划线/连字符转空格)。 */
export function readableNameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || fileName;
}

/**
 * 检查一份 Markdown 字节内容,提取来源元数据。
 * 标题优先取 frontmatter 或首个一级标题,缺失时用可读的文件名兜底。
 * 这是 BookDocument 的雏形:只负责解析与元数据,不接触渲染器。
 */
export async function inspectMarkdown(
  bytes: Uint8Array,
  sourceFileName: string,
): Promise<MarkdownInspectResult> {
  if (bytes.length === 0) {
    throw new MarkdownInspectError('文件内容为空,无法导入', 'empty');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8').decode(bytes);
  } catch {
    throw new MarkdownInspectError('文件不是有效的 UTF-8 文本', 'corrupt');
  }
  // 空文本(仅空白)视为不可读。
  if (!text.trim()) {
    throw new MarkdownInspectError('文件内容为空,无法导入', 'empty');
  }
  const parsed = parseMarkdown(text);
  const metadata: SourceMetadata = {
    title: parsed.title ?? readableNameFromFileName(sourceFileName),
    author: parsed.author,
    language: null,
  };
  return { metadata };
}