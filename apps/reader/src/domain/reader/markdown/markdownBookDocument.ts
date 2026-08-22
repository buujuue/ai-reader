import type { BookDocumentMetadata } from '../bookDocument';
import { EpubBookDocument } from '../epubBookDocument';
import type { FoliateViewHostFactory } from '../viewHost';
import { buildMarkdownEpub } from './markdownEpub';
import { parseMarkdown, type ParsedMarkdown } from './markdownParser';
import type { CanonicalSearchIndexCache } from '../canonicalSearch';

export interface MarkdownBookDocumentOptions {
  /** Markdown 源文本(UTF-8 字符串)。 */
  text: string;
  /** 来源元数据(经 markdownInspector 提取,标题已做文件名兜底)。 */
  metadata: BookDocumentMetadata;
  /** 可注入的 Foliate 视图宿主工厂(测试用)。 */
  viewHostFactory: FoliateViewHostFactory;
  /** Markdown 正文版本指纹，用于隔离可重建搜索索引。 */
  sourceFingerprint?: string;
  /** 可注入的全文搜索索引缓存。 */
  searchIndexCache?: CanonicalSearchIndexCache;
}

/**
 * Markdown 的 BookDocument 实现。它在打开前把 Markdown 解析、清洗并按一级标题
 * 组装成内存 EPUB,再复用 Foliate 分页器渲染,从而复用分页、搜索、目录、导航与排版
 * 能力(ADR-0004 / ADR-0009)。上层绝不直接操作 Foliate View。
 */
export class MarkdownBookDocument extends EpubBookDocument {
  override readonly format = 'markdown' as const;

  constructor(options: MarkdownBookDocumentOptions) {
    const parsed: ParsedMarkdown = parseMarkdown(options.text);
    const bytes = buildMarkdownEpub({
      parsed,
      metadata: options.metadata,
    });
    super({
      source: new File([
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      ], 'markdown.epub', { type: 'application/epub+zip' }),
      metadata: options.metadata,
      viewHostFactory: options.viewHostFactory,
      format: 'markdown',
      locationKind: 'markdown',
      sourceFingerprint: options.sourceFingerprint ?? 'markdown-source',
      ...(options.searchIndexCache ? { searchIndexCache: options.searchIndexCache } : {}),
    });
  }
}
