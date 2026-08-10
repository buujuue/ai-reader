import type { AnnotationExportDestinationPicker } from '../app/annotationExportDestinationPicker';
import { COMMAND_IDS, type CommandRegistry } from '../commands/commandRegistry';
import type { AnnotationExportWriter } from '../domain/annotation/annotationExportWriter';
import { formatAnnotationMarkdown, makeAnnotationExportFileName } from '../domain/annotation/annotationMarkdown';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import { useLibraryStore } from './libraryStore';
import { useShellUiStore } from './shellUiStore';

export interface AnnotationExportCommandDependencies {
  annotationRepository: AnnotationRepository;
  destinationPicker: AnnotationExportDestinationPicker;
  writer: AnnotationExportWriter;
}

export interface AnnotationExportResult {
  destinationPath: string;
  annotationCount: number;
}

/** 单本批注导出 Command：选择目标、读取材料级批注、生成 Markdown 并交给平台写入。 */
export function registerAnnotationExportCommands(
  registry: CommandRegistry,
  dependencies: AnnotationExportCommandDependencies,
): void {
  registry.register(COMMAND_IDS.annotationExportMarkdown, async (...args: unknown[]) => {
    const materialId = typeof args[0] === 'string' ? args[0] : undefined;
    if (!materialId) return null;

    const material = useLibraryStore
      .getState()
      .materials.find((candidate) => candidate.id === materialId);
    if (!material) {
      const error = new Error(`阅读材料不存在：${materialId}`);
      useShellUiStore.getState().setStatusMessage('批注导出失败：找不到阅读材料');
      throw error;
    }

    try {
      const destinationPath = await dependencies.destinationPicker.pickAnnotationExportDestination(
        makeAnnotationExportFileName(material.title),
      );
      if (!destinationPath) {
        useShellUiStore.getState().setStatusMessage('已取消批注 Markdown 导出');
        return null;
      }

      const annotations = await dependencies.annotationRepository.listByMaterial(materialId);
      const content = formatAnnotationMarkdown({
        material: {
          id: material.id,
          title: material.title,
          author: material.author,
          fingerprint: material.fingerprint,
        },
        annotations,
      });
      await dependencies.writer.writeMarkdown(destinationPath, content);

      const result = { destinationPath, annotationCount: annotations.length };
      useShellUiStore
        .getState()
        .setStatusMessage(`批注 Markdown 已导出，共 ${annotations.length} 条`);
      return result;
    } catch (error) {
      console.error('导出批注 Markdown 失败', error);
      useShellUiStore.getState().setStatusMessage('批注 Markdown 导出失败，未生成可用文件');
      throw error;
    }
  });
}
