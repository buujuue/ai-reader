import { describe, expect, it } from 'vitest';

import { createInMemoryAnnotationExportWriter } from './inMemoryAnnotationExportWriter';
import { annotationExportWriterContract } from './annotationExportWriter.contract';

annotationExportWriterContract(() => createInMemoryAnnotationExportWriter());

describe('内存批注导出写入器', () => {
  it('记录目标路径与 UTF-8 字符串内容', async () => {
    const writer = createInMemoryAnnotationExportWriter();
    await writer.writeMarkdown('notes.md', '# 标题\n\n中文批注');

    expect(writer.getWrites()).toEqual([
      { destinationPath: 'notes.md', content: '# 标题\n\n中文批注' },
    ]);
  });
});
