import { expect, it } from 'vitest';

import type { AnnotationExportWrite } from './inMemoryAnnotationExportWriter';
import type { AnnotationExportWriter } from './annotationExportWriter';

export type AnnotationExportWriterTestAdapter = AnnotationExportWriter & {
  getWrites: () => AnnotationExportWrite[];
};

export type AnnotationExportWriterFactory = () => AnnotationExportWriterTestAdapter;

/** Tauri 与内存写入器共享的最小契约。 */
export function annotationExportWriterContract(makeWriter: AnnotationExportWriterFactory): void {
  it('按目标路径写入原样 Markdown 内容', async () => {
    const writer = makeWriter();
    await writer.writeMarkdown('notes.md', '# 标题\n\n中文批注');
    expect(writer.getWrites()).toEqual([
      { destinationPath: 'notes.md', content: '# 标题\n\n中文批注' },
    ]);
  });
}
