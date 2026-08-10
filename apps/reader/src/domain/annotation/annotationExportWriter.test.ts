import { describe, expect, it } from 'vitest';

import type { TauriInvoke } from '../tauriInvoke';
import { annotationExportWriterContract } from './annotationExportWriter.contract';
import type { AnnotationExportWrite } from './inMemoryAnnotationExportWriter';
import {
  ANNOTATION_EXPORT_COMMAND_NAMES,
  createTauriAnnotationExportWriter,
} from './tauriAnnotationExportWriter';

annotationExportWriterContract(() => {
  const writes: AnnotationExportWrite[] = [];
  const writer = createTauriAnnotationExportWriter(async (_command, args) => {
    const values = args as { destinationPath: string; content: string };
    writes.push({ ...values });
    return undefined;
  });
  return { ...writer, getWrites: () => writes.map((write) => ({ ...write })) };
});

describe('Tauri 批注导出写入器', () => {
  it('使用稳定命令名并传递目标路径与 Markdown 内容', async () => {
    let received: { command: string; args?: Record<string, unknown> } | undefined;
    const invoke: TauriInvoke = async (command, args) => {
      received = args ? { command, args } : { command };
      return undefined;
    };

    await createTauriAnnotationExportWriter(invoke).writeMarkdown(
      'C:/notes/book.md',
      '# 示例书\n',
    );

    expect(received).toEqual({
      command: ANNOTATION_EXPORT_COMMAND_NAMES.writeMarkdown,
      args: { destinationPath: 'C:/notes/book.md', content: '# 示例书\n' },
    });
  });
});
