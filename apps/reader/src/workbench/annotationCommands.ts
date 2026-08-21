import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { Annotation } from '../domain/annotation/annotation';
import {
  buildTextAnchor,
  getRangeOwnerDocuments,
  getSingleSectionSelectionError,
  recoverTextAnchor,
  type TextAnchorSearchMatch,
} from '../domain/annotation/textAnchor';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import type { ReadingMaterial } from '../domain/library/material';
import type { AreaSelection, BookDocument } from '../domain/reader/bookDocument';
import { isPdfTextAnchor } from '../domain/reader/pdf/pdfTextAnchor';
import { useAnnotationStore } from './annotationStore';
import { useLibraryStore } from './libraryStore';
import { useReaderRuntime } from './readerRuntime';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';
import { findViewMaterialId } from './viewUtils';

export interface AnnotationCommandDependencies {
  annotationRepository: AnnotationRepository;
}

const DEFAULT_HIGHLIGHT_COLOR = '#ffd54f';

function nextAnnotationId(): string {
  return crypto.randomUUID();
}

function materialFingerprint(materialId: string): string {
  const material = useLibraryStore
    .getState()
    .materials.find((item: ReadingMaterial) => item.id === materialId);
  return material?.fingerprint ?? '';
}

/**
 * 把某材料当前已加载的全部批注绘制到该材料所有开放阅读文档的覆盖层上。
 * 幂等地重绘:先移除旧覆盖层再逐个绘制,避免脏数据残留。
 */
function redrawAnnotationsForMaterial(materialId: string): void {
  const annotations = useAnnotationStore.getState().getMaterialAnnotations(materialId);
  const documents = useReaderRuntime.getState().documents;
  const viewIds = activeViewsForMaterial(materialId);
  const targets = viewIds
    .map((viewId) => documents.get(viewId))
    .filter((document): document is NonNullable<typeof document> => !!document);
  for (const document of targets) {
    drawAnnotations(document, annotations);
  }
}

/** 幂等地替换一个文档上的批注覆盖层,失联锚点只移除旧覆盖层不重新绘制。 */
function drawAnnotations(document: BookDocument, annotations: Annotation[]): void {
  for (const annotation of annotations) {
    document.removeAnnotation(annotation.anchor.cfi);
  }
  for (const annotation of annotations) {
    if (annotation.anchor.recoveryState === 'orphaned') continue;
    document.addAnnotation({ value: annotation.anchor.cfi, color: annotation.color });
  }
}

/** 某材料当前开放(在工作区有标签)的视图 id 集合(用于判断绘制归属)。 */
function activeViewsForMaterial(materialId: string): string[] {
  const state = useWorkspaceStore.getState();
  const viewIds: string[] = [];
  for (const group of state.editorGroups) {
    for (const view of group.views) {
      if (view.materialId === materialId) viewIds.push(view.id);
    }
  }
  return viewIds;
}

/**
 * 加载某阅读视图归属材料的批注并绘制到该视图文档覆盖层。
 * 供阅读视图挂载完成后调用;批注是材料级实体,可安全地重复加载。
 */
export async function loadAnnotationsForView(
  dependencies: { annotationRepository: AnnotationRepository },
  viewId: string,
): Promise<void> {
  const materialId = findViewMaterialId(viewId);
  if (!materialId) return;
  const document = useReaderRuntime.getState().getDocument(viewId);
  if (!document) return;
  await loadAnnotationsForMaterial(dependencies, materialId, document);
  redrawAnnotationsForMaterial(materialId);
}

async function loadAnnotationsForMaterial(
  dependencies: { annotationRepository: AnnotationRepository },
  materialId: string,
  preferredDocument?: BookDocument,
): Promise<void> {
  const annotations = await dependencies.annotationRepository.listByMaterial(materialId);
  const document = preferredDocument ?? findMaterialDocument(materialId);
  const material = useLibraryStore
    .getState()
    .materials.find((item: ReadingMaterial) => item.id === materialId);
  const currentVersion = material?.fingerprint ?? '';
  const loadedAnnotations =
    document && currentVersion
      ? await recoverAnnotationsForDocument(
          document,
          annotations,
          currentVersion,
          dependencies.annotationRepository,
        )
      : annotations;
  useAnnotationStore.getState().setMaterialAnnotations(materialId, loadedAnnotations);
}

function findMaterialDocument(materialId: string): BookDocument | undefined {
  return activeViewsForMaterial(materialId)
    .map((viewId) => useReaderRuntime.getState().getDocument(viewId))
    .find((document): document is BookDocument => !!document);
}

/**
 * 在材料版本变化后逐条寻找批注引文。搜索任务按材料串行执行,避免 Foliate
 * 的临时搜索高亮互相覆盖;恢复结束后清理临时结果,只留下正式批注覆盖层。
 */
async function recoverAnnotationsForDocument(
  document: BookDocument,
  annotations: Annotation[],
  currentVersion: string,
  repository: AnnotationRepository,
): Promise<Annotation[]> {
  const recovered: Annotation[] = [];
  const pendingPersistence: Annotation[] = [];
  let orphanedCount = 0;

  for (const annotation of annotations) {
    if (annotation.anchor.documentVersion === currentVersion) {
      recovered.push(annotation);
      if (annotation.anchor.recoveryState === 'orphaned') orphanedCount += 1;
      continue;
    }

    // PDF 区域锚点依赖页码与归一化矩形，不把它当作文本引文参与恢复，避免版本变化后误附着。
    if (isPdfTextAnchor(annotation.anchor.cfi)) {
      const next = {
        ...annotation,
        anchor: { ...annotation.anchor, recoveryState: 'orphaned' as const },
      };
      recovered.push(next);
      if (next.anchor.recoveryState !== annotation.anchor.recoveryState) {
        pendingPersistence.push(next);
      }
      orphanedCount += 1;
      continue;
    }

    let originalCfiResolved = false;
    try {
      originalCfiResolved = (await document.canResolveAnnotation?.(annotation.anchor.cfi)) ?? false;
    } catch {
      originalCfiResolved = false;
    }
    if (originalCfiResolved) {
      const nextAnchor = {
        ...annotation.anchor,
        documentVersion: currentVersion,
        recoveryState: 'resolved' as const,
      };
      const next = { ...annotation, anchor: nextAnchor };
      recovered.push(next);
      pendingPersistence.push(next);
      continue;
    }

    const matches: TextAnchorSearchMatch[] = [];
    try {
      const generator = document.search({ query: annotation.anchor.quote, matchCase: true });
      for await (const event of generator) {
        if (event.kind === 'match') matches.push(event.match);
      }
    } catch {
      // 搜索引擎异常时也不能把旧 CFI 当作安全位置,先保留为失联并等待重试。
      const next = {
        ...annotation,
        anchor: { ...annotation.anchor, recoveryState: 'orphaned' as const },
      };
      recovered.push(next);
      if (next.anchor.recoveryState !== annotation.anchor.recoveryState) {
        pendingPersistence.push(next);
      }
      orphanedCount += 1;
      continue;
    } finally {
      try {
        document.clearSearch();
      } catch {
        /* 清理临时搜索结果失败不影响失联状态的持久化。 */
      }
    }

    const nextAnchor = recoverTextAnchor(annotation.anchor, currentVersion, matches);
    const changed =
      nextAnchor.cfi !== annotation.anchor.cfi ||
      nextAnchor.documentVersion !== annotation.anchor.documentVersion ||
      nextAnchor.recoveryState !== annotation.anchor.recoveryState;
    const next = changed ? { ...annotation, anchor: nextAnchor } : annotation;
    if (next.anchor.recoveryState === 'orphaned') orphanedCount += 1;
    recovered.push(next);
    if (changed) pendingPersistence.push(next);
  }

  // Recovery may touch several annotations. Persist the complete set through
  // one adapter-level commit so a failure cannot leave the first half migrated
  // while the runtime store still contains the old set.
  if (pendingPersistence.length > 0) {
    const saved = await repository.saveAnnotations(pendingPersistence);
    const savedById = new Map(saved.map((annotation) => [annotation.id, annotation]));
    for (let index = 0; index < recovered.length; index += 1) {
      const savedAnnotation = savedById.get(recovered[index]!.id);
      if (savedAnnotation) recovered[index] = savedAnnotation;
    }
  }

  if (orphanedCount > 0) {
    useShellUiStore
      .getState()
      .setStatusMessage(`${orphanedCount} 条批注无法安全恢复,已保留为失联批注`);
  }
  return recovered;
}

export function registerAnnotationCommands(
  registry: CommandRegistry,
  dependencies: AnnotationCommandDependencies,
): void {
  // 加载某材料全部批注并绘制到其开放阅读视图覆盖层。
  registry.register(COMMAND_IDS.annotationLoadForMaterial, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) return;
    await loadAnnotationsForMaterial(dependencies, materialId);
    redrawAnnotationsForMaterial(materialId);
  });

  // 从当前选中文本创建一条高亮批注。
  registry.register(COMMAND_IDS.annotationCreateHighlight, async (...args: unknown[]) => {
    const viewId = args[0] as string | undefined;
    const range = args[1] as Range | undefined;
    if (!viewId || !range) return;
    const materialId = findViewMaterialId(viewId);
    if (!materialId) return;
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!document) return;
    const rangeDocuments = getRangeOwnerDocuments(range);
    const selectionError =
      document.format === 'epub'
        ? getSingleSectionSelectionError(
            range,
            (contentDocument) => document.getContentDocumentIndex?.(contentDocument) ?? null,
          )
        : null;
    if (selectionError) {
      useShellUiStore.getState().setStatusMessage(selectionError);
      return;
    }
    const contentDocumentIndex = rangeDocuments.start
      ? document.getContentDocumentIndex?.(rangeDocuments.start) ?? null
      : null;
    const index = contentDocumentIndex ?? document.getCurrentIndex();
    if (index === null) return;
    const quote = range.toString().trim();
    if (!quote) return;
    const cfi = document.getCFI(index, range);
    if (!cfi) return;

    const now = Date.now();
    const annotation: Annotation = {
      id: nextAnnotationId(),
      materialId,
      anchor: buildTextAnchor(cfi, range, materialFingerprint(materialId)),
      style: 'highlight',
      color: DEFAULT_HIGHLIGHT_COLOR,
      note: '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const saved = await dependencies.annotationRepository.saveAnnotation(annotation);
    useAnnotationStore.getState().upsertAnnotation(saved);
    redrawAnnotationsForMaterial(materialId);
  });

  // 从扫描 PDF 的拖选区域创建一条没有文本引文的页内批注。
  registry.register(COMMAND_IDS.annotationCreatePdfArea, async (...args: unknown[]) => {
    const viewId = args[0] as string | undefined;
    const selection = args[1] as AreaSelection | undefined;
    if (!viewId || !selection) return;
    const materialId = findViewMaterialId(viewId);
    if (!materialId) return;
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!document || document.format !== 'pdf' || !document.getAreaAnchor) return;
    const cfi = document.getAreaAnchor(selection);
    if (!cfi) return;

    const now = Date.now();
    const annotation: Annotation = {
      id: nextAnnotationId(),
      materialId,
      anchor: {
        cfi,
        quote: '',
        before: '',
        after: '',
        documentVersion: materialFingerprint(materialId),
        recoveryState: 'resolved',
      },
      style: 'highlight',
      color: DEFAULT_HIGHLIGHT_COLOR,
      note: '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const saved = await dependencies.annotationRepository.saveAnnotation(annotation);
    useAnnotationStore.getState().upsertAnnotation(saved);
    redrawAnnotationsForMaterial(materialId);
  });

  // 为已有高亮添加或编辑文字笔记。
  registry.register(COMMAND_IDS.annotationUpdateNote, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    const annotationId = args[1] as string | undefined;
    const note = args[2] as string | undefined;
    if (!materialId || !annotationId || typeof note !== 'string') return;
    const current = useAnnotationStore
      .getState()
      .getMaterialAnnotations(materialId)
      .find((annotation) => annotation.id === annotationId);
    if (!current) return;
    const updated = { ...current, note, updatedAt: Date.now() };
    const saved = await dependencies.annotationRepository.saveAnnotation(updated);
    useAnnotationStore.getState().upsertAnnotation(saved);
  });

  // 逻辑删除一条批注并移除其覆盖层。
  registry.register(COMMAND_IDS.annotationDelete, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    const annotationId = args[1] as string | undefined;
    if (!materialId || !annotationId) return;
    const annotation = useAnnotationStore
      .getState()
      .getMaterialAnnotations(materialId)
      .find((item) => item.id === annotationId);
    await dependencies.annotationRepository.deleteAnnotation(annotationId);
    useAnnotationStore.getState().removeAnnotation(materialId, annotationId);
    useShellUiStore.getState().setAnnotationUndoTarget({ materialId, annotationId });
    if (annotation) {
      for (const document of useReaderRuntime.getState().documents.values()) {
        try {
          document.removeAnnotation(annotation.anchor.cfi);
        } catch {
          // 持久化已经成功;覆盖层失败不会回滚或丢失批注,下次加载会重绘。
        }
      }
    }
  });

  // 恢复一条软删除批注。恢复只清除 tombstone,不重新计算或改变原锚点。
  registry.register(COMMAND_IDS.annotationRestore, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    const annotationId = args[1] as string | undefined;
    if (!materialId || !annotationId) return;
    const restored = await dependencies.annotationRepository.restoreAnnotation(annotationId);
    if (!restored) {
      useShellUiStore.getState().setStatusMessage('批注已不存在或未处于删除状态');
      return;
    }
    if (restored.materialId !== materialId) {
      throw new Error('恢复批注归属材料不匹配');
    }
    useAnnotationStore.getState().upsertAnnotation(restored);
    useShellUiStore.getState().setAnnotationUndoTarget(null);
    redrawAnnotationsForMaterial(materialId);
    useShellUiStore.getState().setStatusMessage('已恢复批注');
  });
}
