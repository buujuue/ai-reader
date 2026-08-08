import type { FilePicker } from '../app/filePicker';
import { EpubInspectError, inspectEpub } from '../domain/library/epub/epubInspector';
import type { ImportRepository } from '../domain/library/importRepository';
import type { ReadingMaterial } from '../domain/library/material';

export interface ImportBookDependencies {
  importRepository: ImportRepository;
  filePicker: FilePicker;
}

/** 单个文件导入结果。失败时保留可行动的简体中文文案与分类,便于 UI 逐文件汇报。 */
export type ImportOutcome =
  | { kind: 'success'; sourcePath: string; fileName: string; material: ReadingMaterial }
  | { kind: 'failure'; sourcePath: string; fileName: string; failure: ImportFailure };

/** 失败分类,UI 据此选择针对性的操作提示。 */
export type ImportFailureKind =
  | 'empty'
  | 'unsupported'
  | 'corrupt'
  | 'permission'
  | 'space'
  | 'other';

export interface ImportFailure {
  kind: ImportFailureKind;
  message: string;
}

/**
 * 批量导入编排:一次选择多份文件,顺序逐个执行 stage → inspect → commit。
 * 顺序处理保证同一时刻只有一份文件进入 JavaScript 内存,大文件不整体并发读入。
 * 单个文件失败只记录该文件的结果并丢弃其暂存副本,不中断或回滚其它文件的成功结果。
 * 用户取消选择返回 null,不创建任何记录或暂存文件。
 */
export async function importBooks(
  dependencies: ImportBookDependencies,
): Promise<ImportOutcome[] | null> {
  const sourcePaths = await dependencies.filePicker.pickEpubs();
  if (!sourcePaths || sourcePaths.length === 0) {
    return null;
  }

  const outcomes: ImportOutcome[] = [];
  for (const sourcePath of sourcePaths) {
    outcomes.push(await importOneFile(sourcePath, dependencies));
  }
  return outcomes;
}

async function importOneFile(
  sourcePath: string,
  dependencies: ImportBookDependencies,
): Promise<ImportOutcome> {
  let staged;
  try {
    staged = await dependencies.importRepository.stageImport(sourcePath);
    const bytes = await dependencies.importRepository.readStagedFile(staged);
    const { metadata } = await inspectEpub(bytes);
    const material = await dependencies.importRepository.commitImport(staged, metadata);
    return {
      kind: 'success',
      sourcePath,
      fileName: staged.originalFileName,
      material,
    };
  } catch (error) {
    if (staged) {
      try {
        await dependencies.importRepository.discardImport(staged);
      } catch {
        // 丢弃失败不掩盖原始失败,留给启动恢复器兜底。
      }
    }
    return {
      kind: 'failure',
      sourcePath,
      fileName: fileNameOf(sourcePath),
      failure: classifyImportError(error),
    };
  }
}

/** 把任意导入阶段的错误归类为带行动提示的领域化失败。 */
export function classifyImportError(error: unknown): ImportFailure {
  if (error instanceof EpubInspectError) {
    return { kind: error.kind, message: error.message };
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/没有权限|权限被拒绝|permission|denied|EACCES/i.test(text)) {
    return { kind: 'permission', message: '没有权限读取该文件,请检查文件的访问权限' };
  }
  if (/磁盘空间|空间不足|磁盘已满|ENOSPC|storage.?full|space/i.test(text)) {
    return { kind: 'space', message: '磁盘空间不足,无法完成导入,请释放空间后重试' };
  }
  if (/为空|empty|0 字节/i.test(text)) {
    return { kind: 'empty', message: '文件内容为空,无法导入' };
  }
  return { kind: 'other', message: '导入失败,文件可能不受支持或已损坏' };
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}