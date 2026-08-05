import type { FilePicker } from '../app/filePicker';
import { inspectEpub } from '../domain/library/epub/epubInspector';
import type { ImportRepository } from '../domain/library/importRepository';
import type { ReadingMaterial } from '../domain/library/material';

export interface ImportBookDependencies {
  importRepository: ImportRepository;
  filePicker: FilePicker;
}

/**
 * 编排 stage → inspect → commit 的导入断言。
 * 取消选择返回 null,不创建任何记录或暂存文件;损坏文件抛出领域化错误。
 */
export async function importOneBook(
  dependencies: ImportBookDependencies,
): Promise<ReadingMaterial | null> {
  const sourcePath = await dependencies.filePicker.pickEpub();
  if (!sourcePath) {
    return null;
  }

  const staged = await dependencies.importRepository.stageImport(sourcePath);
  const bytes = await dependencies.importRepository.readStagedFile(staged);
  const { metadata } = await inspectEpub(bytes);
  return dependencies.importRepository.commitImport(staged, metadata);
}
