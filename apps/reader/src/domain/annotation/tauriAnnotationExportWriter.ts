import { invoke } from '@tauri-apps/api/core';

import type { TauriInvoke } from '../tauriInvoke';
import type { AnnotationExportWriter } from './annotationExportWriter';

export const ANNOTATION_EXPORT_COMMAND_NAMES = {
  writeMarkdown: 'write_annotation_markdown',
} as const;

export function createTauriAnnotationExportWriter(invokeFn: TauriInvoke): AnnotationExportWriter {
  return {
    async writeMarkdown(destinationPath: string, content: string): Promise<void> {
      await invokeFn(ANNOTATION_EXPORT_COMMAND_NAMES.writeMarkdown, {
        destinationPath,
        content,
      });
    },
  };
}

export function createDefaultTauriAnnotationExportWriter(): AnnotationExportWriter {
  return createTauriAnnotationExportWriter((command, args) => invoke(command, args));
}
