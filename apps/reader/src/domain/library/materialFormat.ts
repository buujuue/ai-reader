/** 阅读材料格式。第一版仅 EPUB,但保留 PDF/Markdown 扩展名推断,便于书库展示与后续格式接入。 */
export type MaterialFormat = 'epub' | 'pdf' | 'markdown' | 'unknown';

/** markdown 的常见扩展名(不含点)。 */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mkd', 'mdown']);

/**
 * 从「原始源文件名」推断材料格式。第一版不依赖跨 TS/Rust 契约新增字段,
 * 仅由扩展名后缀判断;未知扩展名归为 unknown,由界面展示占位标签。
 */
export function formatFromSourceFileName(fileName: string): MaterialFormat {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) {
    return 'unknown';
  }
  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  if (ext === 'epub') {
    return 'epub';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return 'markdown';
  }
  return 'unknown';
}

/** 格式的展示标签(简体中文)。 */
export function formatLabel(format: MaterialFormat): string {
  switch (format) {
    case 'epub':
      return 'EPUB';
    case 'pdf':
      return 'PDF';
    case 'markdown':
      return 'Markdown';
    case 'unknown':
      return '未知格式';
  }
}