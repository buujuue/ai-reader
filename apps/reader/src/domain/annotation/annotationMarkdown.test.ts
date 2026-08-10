import { describe, expect, it } from 'vitest';

import type { Annotation } from './annotation';
import {
  formatAnnotationMarkdown,
  makeAnnotationExportFileName,
} from './annotationMarkdown';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'annotation-1',
    materialId: 'material-1',
    anchor: {
      cfi: 'epubcfi(/6/4)!/4/2/2/1:0',
      quote: '重要的原文',
      before: '前文',
      after: '后文',
      documentVersion: 'fingerprint-1',
      recoveryState: 'resolved',
    },
    style: 'highlight',
    color: '#ffd54f',
    note: '我的笔记',
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...overrides,
  };
}

describe('formatAnnotationMarkdown', () => {
  it('包含标题、作者、材料标识、引文、笔记与可理解的文本位置', () => {
    const markdown = formatAnnotationMarkdown({
      material: {
        id: 'material-1',
        title: '示例书',
        author: '示例作者',
        fingerprint: 'fingerprint-1',
      },
      annotations: [makeAnnotation()],
    });

    expect(markdown).toContain('# 示例书');
    expect(markdown).toContain('- 作者：示例作者');
    expect(markdown).toContain('- 材料标识：`material-1`');
    expect(markdown).toContain('> 重要的原文');
    expect(markdown).toContain('> 我的笔记');
    expect(markdown).toContain('位置：文本位置');
    expect(markdown).toContain('人类可读批注出口；不承担完整书库恢复');
  });

  it('包含扫描 PDF 区域的页码与区域描述', () => {
    const markdown = formatAnnotationMarkdown({
      material: { id: 'pdf-1', title: '扫描资料', author: null, fingerprint: 'fingerprint-1' },
      annotations: [
        makeAnnotation({
          anchor: {
            ...makeAnnotation().anchor,
            cfi: 'pdf-text:3:0.10000:0.20000:0.50000:0.25000',
            quote: '',
          },
          note: '看这一块',
        }),
      ],
    });

    expect(markdown).toContain('类型：区域批注');
    expect(markdown).toContain('PDF 第 3 页');
    expect(markdown).toContain('左 10%、上 20%、宽 50%、高 25%');
    expect(markdown).toContain('> 看这一块');
  });

  it('失联批注明确标记状态并保留原引文和笔记', () => {
    const markdown = formatAnnotationMarkdown({
      material: { id: 'material-1', title: '示例书', author: null, fingerprint: 'fingerprint-1' },
      annotations: [
        makeAnnotation({
          anchor: { ...makeAnnotation().anchor, recoveryState: 'orphaned' },
        }),
      ],
    });

    expect(markdown).toContain('状态：失联批注');
    expect(markdown).toContain('无法安全恢复');
    expect(markdown).toContain('> 重要的原文');
    expect(markdown).toContain('> 我的笔记');
  });

  it('文档版本变化但尚未恢复时不会伪装成已定位', () => {
    const markdown = formatAnnotationMarkdown({
      material: { id: 'material-1', title: '示例书', author: null, fingerprint: 'new-version' },
      annotations: [
        makeAnnotation({
          anchor: { ...makeAnnotation().anchor, documentVersion: 'old-version' },
        }),
      ],
    });

    expect(markdown).toContain('状态：待恢复');
    expect(markdown).toContain('文档版本已变化，尚未确认位置');
    expect(markdown).not.toContain('状态：已定位');
  });

  it('没有批注时仍生成完整且有效的 Markdown 文档', () => {
    const markdown = formatAnnotationMarkdown({
      material: { id: 'material-1', title: '示例书', author: null, fingerprint: 'fingerprint-1' },
      annotations: [],
    });

    expect(markdown).toContain('## 批注');
    expect(markdown).toContain('暂无批注。');
    expect(markdown.endsWith('\n')).toBe(true);
  });
});

describe('makeAnnotationExportFileName', () => {
  it('把材料标题转换为安全的 Markdown 默认文件名', () => {
    expect(makeAnnotationExportFileName('示例:/书')).toBe('示例--书-批注.md');
  });
});
