import type { AnnotationExportWriter } from './annotationExportWriter';

export interface AnnotationExportWrite {
  destinationPath: string;
  content: string;
}

/** 浏览器降级与测试使用的内存写入器，不触碰本地文件系统。 */
export function createInMemoryAnnotationExportWriter(): AnnotationExportWriter & {
  getWrites: () => AnnotationExportWrite[];
} {
  const writes: AnnotationExportWrite[] = [];
  return {
    async writeMarkdown(destinationPath: string, content: string): Promise<void> {
      writes.push({ destinationPath, content });
    },
    getWrites(): AnnotationExportWrite[] {
      return writes.map((write) => ({ ...write }));
    },
  };
}
