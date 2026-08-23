import type { FilePicker } from '../app/filePicker';
import {
  EpubInspectError,
  inspectEpub,
  type EpubPreflightReport,
} from '../domain/library/epub/epubInspector';
import type { ImportRepository } from '../domain/library/importRepository';
import type { CoverAsset, ReadingMaterial, SourceMetadata, StagedImport } from '../domain/library/material';
import { formatFromSourceFileName } from '../domain/library/materialFormat';
import {
  findVersionMigrationCandidates,
  type VersionMigrationCandidate,
} from '../domain/library/versionMigration';
import { createPdfSourceFromBytes, type PdfJsLib } from '../domain/reader/pdf/pdfLibrary';
import { PdfInspectError, inspectPdf } from '../domain/reader/pdf/pdfInspector';
import { MarkdownInspectError, inspectMarkdown } from '../domain/reader/markdown/markdownInspector';

export interface ImportBookDependencies {
  importRepository: ImportRepository;
  filePicker: FilePicker;
  /** 可注入的 PDF.js 库(测试用);缺省懒加载真实引擎。 */
  pdfLib?: PdfJsLib | undefined;
}

/** 单个文件导入结果。失败时保留可行动的简体中文文案与分类,便于 UI 逐文件汇报。 */
export type ImportOutcome =
  | {
      kind: 'success';
      sourcePath: string;
      fileName: string;
      material: ReadingMaterial;
      /** EPUB 局部降级报告；在 commit 前生成，供 UI 展示可行动提示。 */
      preflight?: EpubPreflightReport;
      /** 来源封面派生失败时的非阻塞诊断提示。 */
      coverWarning?: string;
    }
  | {
      kind: 'migrationCandidate';
      sourcePath: string;
      fileName: string;
      candidates: VersionMigrationCandidate[];
      preflight?: EpubPreflightReport;
      /** 来源封面派生失败时的非阻塞诊断提示。 */
      coverWarning?: string;
    }
  | { kind: 'failure'; sourcePath: string; fileName: string; failure: ImportFailure };

/** 失败分类,UI 据此选择针对性的操作提示。 */
export type ImportFailureKind =
  | 'empty'
  | 'unsupported'
  | 'corrupt'
  | 'drm'
  | 'budget'
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
  const sourcePaths = await dependencies.filePicker.pickBooks();
  if (!sourcePaths || sourcePaths.length === 0) {
    return null;
  }

  const outcomes: ImportOutcome[] = [];
  let existingMaterials = await dependencies.importRepository.listMaterials();
  for (const sourcePath of sourcePaths) {
    const outcome = await importOneFile(sourcePath, dependencies, existingMaterials);
    outcomes.push(outcome);
    if (outcome.kind === 'success') {
      existingMaterials = [...existingMaterials, outcome.material];
    }
  }
  return outcomes;
}

async function importOneFile(
  sourcePath: string,
  dependencies: ImportBookDependencies,
  existingMaterials: readonly ReadingMaterial[],
): Promise<ImportOutcome> {
  let staged: StagedImport | undefined;
  let stagedSuccessfully = false;
  try {
    const stagedImport = await dependencies.importRepository.stageImport(sourcePath);
    staged = stagedImport;
    stagedSuccessfully = true;
    const bytes = await dependencies.importRepository.readStagedFile(stagedImport);
    const inspected = await inspectFile(bytes, stagedImport.originalFileName, dependencies.pdfLib);
    const candidates = findVersionMigrationCandidates(
      existingMaterials,
      stagedImport,
      inspected.metadata,
    ).map((material) => ({
      material,
      staged: stagedImport,
      metadata: inspected.metadata,
      sourceCover: inspected.sourceCover,
    }));
    if (candidates.length > 0) {
      return {
        kind: 'migrationCandidate',
        sourcePath,
        fileName: stagedImport.originalFileName,
        candidates,
        ...(inspected.preflight ? { preflight: inspected.preflight } : {}),
        ...(inspected.coverWarning ? { coverWarning: inspected.coverWarning } : {}),
      };
    }
    const material = await dependencies.importRepository.commitImport(
      stagedImport,
      inspected.metadata,
      inspected.sourceCover,
    );
    return {
      kind: 'success',
      sourcePath,
      fileName: stagedImport.originalFileName,
      material,
      ...(inspected.preflight ? { preflight: inspected.preflight } : {}),
      ...(inspected.coverWarning ? { coverWarning: inspected.coverWarning } : {}),
    };
  } catch (error) {
    if (staged && stagedSuccessfully) {
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

/** 按源文件扩展名分派检查:EPUB 用 zip 清单解析,PDF 用 PDF.js,Markdown 用解析器。 */
async function inspectFile(
  bytes: Uint8Array,
  originalFileName: string,
  pdfLib?: PdfJsLib,
): Promise<{
  metadata: SourceMetadata;
  sourceCover: CoverAsset | null;
  preflight?: EpubPreflightReport;
  coverWarning?: string;
}> {
  const format = formatFromSourceFileName(originalFileName);
  if (format === 'pdf') {
    const result = await inspectPdf(createPdfSourceFromBytes(bytes), pdfLib);
    return {
      metadata: result.metadata,
      sourceCover: result.sourceCover,
      ...(result.coverWarning ? { coverWarning: result.coverWarning } : {}),
    };
  }
  if (format === 'epub') {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const result = await inspectEpub(new Blob([buffer], { type: 'application/epub+zip' }));
    return {
      metadata: result.metadata,
      sourceCover: result.sourceCover,
      ...(result.coverWarning ? { coverWarning: result.coverWarning } : {}),
      preflight: result.preflight,
    };
  }
  if (format === 'markdown') {
    const result = await inspectMarkdown(bytes, originalFileName);
    return { metadata: result.metadata, sourceCover: null };
  }
  throw new MarkdownInspectError('不支持的文件格式:仅支持 EPUB、PDF 与 Markdown', 'unsupported');
}

/** 把任意导入阶段的错误归类为带行动提示的领域化失败。 */
export function classifyImportError(error: unknown): ImportFailure {
  if (error instanceof EpubInspectError) {
    return { kind: error.kind, message: error.message };
  }
  if (error instanceof PdfInspectError || error instanceof MarkdownInspectError) {
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
