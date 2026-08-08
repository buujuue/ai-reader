import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { Annotation } from '../domain/annotation/annotation';
import { buildTextAnchor } from '../domain/annotation/textAnchor';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import type { ReadingMaterial } from '../domain/library/material';
import { useAnnotationStore } from './annotationStore';
import { useLibraryStore } from './libraryStore';
import { useReaderRuntime } from './readerRuntime';
import { useWorkspaceStore } from './workspaceStore';

export interface AnnotationCommandDependencies {
  annotationRepository: AnnotationRepository;
}

const DEFAULT_HIGHLIGHT_COLOR = '#ffd54f';

function nextAnnotationId(): string {
  return crypto.randomUUID();
}

function findViewMaterialId(viewId: string): string | null {
  const state = useWorkspaceStore.getState();
  for (const group of state.editorGroups) {
    const view = group.views.find((view) => view.id === viewId);
    if (view) return view.materialId;
  }
  return null;
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
    for (const annotation of annotations) {
      document.removeAnnotation(annotation.anchor.cfi);
    }
    for (const annotation of annotations) {
      document.addAnnotation({ value: annotation.anchor.cfi, color: annotation.color });
    }
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
  const annotations = await dependencies.annotationRepository.listByMaterial(materialId);
  useAnnotationStore.getState().setMaterialAnnotations(materialId, annotations);
  redrawAnnotationsForView(materialId, viewId);
}

/** 把某材料的批注绘制到指定开放阅读文档的覆盖层(幂等重绘)。 */
function redrawAnnotationsForView(materialId: string, viewId: string): void {
  const annotations = useAnnotationStore.getState().getMaterialAnnotations(materialId);
  const document = useReaderRuntime.getState().getDocument(viewId);
  if (!document) return;
  for (const annotation of annotations) {
    document.removeAnnotation(annotation.anchor.cfi);
  }
  for (const annotation of annotations) {
    document.addAnnotation({ value: annotation.anchor.cfi, color: annotation.color });
  }
}

export function registerAnnotationCommands(
  registry: CommandRegistry,
  dependencies: AnnotationCommandDependencies,
): void {
  // 加载某材料全部批注并绘制到其开放阅读视图覆盖层。
  registry.register(COMMAND_IDS.annotationLoadForMaterial, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    if (!materialId) return;
    const annotations = await dependencies.annotationRepository.listByMaterial(materialId);
    useAnnotationStore.getState().setMaterialAnnotations(materialId, annotations);
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
    const index = document.getCurrentIndex();
    if (index === null) return;
    const quote = range.toString().trim();
    if (!quote) return;

    const annotation: Annotation = {
      id: nextAnnotationId(),
      materialId,
      anchor: buildTextAnchor(document.getCFI(index, range), range, materialFingerprint(materialId)),
      style: 'highlight',
      color: DEFAULT_HIGHLIGHT_COLOR,
      note: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
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
    await dependencies.annotationRepository.deleteAnnotation(annotationId);
    const annotation = useAnnotationStore
      .getState()
      .getMaterialAnnotations(materialId)
      .find((item) => item.id === annotationId);
    useAnnotationStore.getState().removeAnnotation(materialId, annotationId);
    if (annotation) {
      for (const document of useReaderRuntime.getState().documents.values()) {
        document.removeAnnotation(annotation.anchor.cfi);
      }
    }
  });
}