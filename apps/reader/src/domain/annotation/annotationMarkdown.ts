import type { Annotation } from './annotation';
import { decodePdfTextAnchor, isPdfTextAnchor } from '../reader/pdf/pdfTextAnchor';

export interface AnnotationMarkdownMaterial {
  id: string;
  title: string;
  author: string | null;
  fingerprint: string;
}

export interface AnnotationMarkdownInput {
  material: AnnotationMarkdownMaterial;
  annotations: readonly Annotation[];
}

function singleLine(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function codeSpan(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

function quoteBlock(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '> （无内容）';
  return normalized
    .split(/\r?\n/)
    .map((line) => `> ${line || '>'}`)
    .join('\n');
}

function percentage(value: number): string {
  const clamped = Math.min(1, Math.max(0, value));
  return `${(clamped * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

function pdfLocation(annotation: Annotation): string | null {
  if (!isPdfTextAnchor(annotation.anchor.cfi)) return null;
  const location = decodePdfTextAnchor(annotation.anchor.cfi);
  if (!location) {
    return `PDF 区域（原始锚点：${codeSpan(annotation.anchor.cfi)}）`;
  }
  const { rect } = location;
  return `PDF 第 ${location.page} 页，区域：左 ${percentage(rect.x)}、上 ${percentage(rect.y)}、宽 ${percentage(rect.width)}、高 ${percentage(rect.height)}`;
}

function textContext(annotation: Annotation): string {
  const context: string[] = [];
  if (annotation.anchor.before.trim()) {
    context.push(`前文：“${singleLine(annotation.anchor.before, '')}”`);
  }
  if (annotation.anchor.after.trim()) {
    context.push(`后文：“${singleLine(annotation.anchor.after, '')}”`);
  }
  return context.length > 0 ? `；${context.join('；')}` : '';
}

function isOutdated(annotation: Annotation, material: AnnotationMarkdownMaterial): boolean {
  return annotation.anchor.documentVersion !== material.fingerprint;
}

function locationDescription(
  annotation: Annotation,
  material: AnnotationMarkdownMaterial,
): string {
  const outdated = isOutdated(annotation, material);
  const pdf = pdfLocation(annotation);
  if (pdf) {
    if (annotation.anchor.recoveryState === 'orphaned') {
      return `失联（原始位置：${pdf}；无法安全恢复）`;
    }
    return outdated
      ? `待恢复（原始位置：${pdf}；文档版本已变化，尚未确认位置）`
      : pdf;
  }

  const cfi = annotation.anchor.cfi
    ? `CFI：${codeSpan(annotation.anchor.cfi)}`
    : '未记录文本位置';
  const textPosition = `文本位置（${cfi}${textContext(annotation)}）`;
  if (annotation.anchor.recoveryState === 'orphaned') {
    return `失联（原始${textPosition}；无法安全恢复）`;
  }
  if (annotation.anchor.recoveryState === 'reanchored') {
    return `已重锚（${textPosition}；已根据引文恢复到新位置）`;
  }
  return outdated
    ? `待恢复（原始${textPosition}；文档版本已变化，尚未确认位置）`
    : textPosition;
}

function annotationType(annotation: Annotation): string {
  return annotation.anchor.quote.trim() ? '文字高亮' : '区域批注';
}

function formatAnnotation(
  annotation: Annotation,
  material: AnnotationMarkdownMaterial,
  index: number,
): string[] {
  const lines = [`### 批注 ${index}`, `类型：${annotationType(annotation)}`];
  const quote = annotation.anchor.quote.trim();
  if (quote) {
    lines.push('', '引文：', quoteBlock(quote));
  } else {
    lines.push('', '引文：无文字引文（区域批注）');
  }

  lines.push('', `位置：${locationDescription(annotation, material)}`);
  const status =
    annotation.anchor.recoveryState === 'orphaned'
      ? '失联批注（原引文与笔记已保留，未伪装成已定位）'
      : annotation.anchor.recoveryState === 'reanchored'
        ? '已重锚批注（根据引文恢复到新位置）'
      : isOutdated(annotation, material)
        ? '待恢复（文档版本已变化，尚未确认位置）'
        : '已定位';
  lines.push(
    '',
    `状态：${status}`,
  );
  if (annotation.note.trim()) {
    lines.push('', '笔记：', quoteBlock(annotation.note));
  }
  lines.push('', `颜色：${codeSpan(annotation.color)}`);
  return lines;
}

/** 生成稳定、可读且不承担完整书库恢复职责的单本批注 Markdown。 */
export function formatAnnotationMarkdown(input: AnnotationMarkdownInput): string {
  const title = singleLine(input.material.title, '未命名材料');
  const author = singleLine(input.material.author ?? '', '未知作者');
  const annotations = [...input.annotations].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const lines = [
    `# ${title}`,
    '',
    `- 作者：${author}`,
    `- 材料标识：${codeSpan(input.material.id)}`,
    '',
    '> 这是 AI Reader 的人类可读批注出口；不承担完整书库恢复。',
    '',
    '## 批注',
    '',
  ];

  if (annotations.length === 0) {
    lines.push('暂无批注。');
  } else {
    annotations.forEach((annotation, index) => {
      lines.push(...formatAnnotation(annotation, input.material, index + 1), '');
    });
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** 保存对话框使用的安全默认文件名，不把标题当作路径。 */
export function makeAnnotationExportFileName(title: string): string {
  const safeTitle = singleLine(title, '阅读材料')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\.+$/g, '')
    .trim();
  return `${safeTitle || '阅读材料'}-批注.md`;
}
