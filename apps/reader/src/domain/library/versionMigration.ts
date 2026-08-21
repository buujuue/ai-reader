import type { Annotation } from '../annotation/annotation';
import {
  evaluateTextAnchorRecovery,
  type TextAnchorRecoveryReason,
  type TextAnchorSearchMatch,
} from '../annotation/textAnchor';
import type { BookDocument } from '../reader/bookDocument';
import type { ReadingLocation } from '../reader/readingLocation';
import type { WorkspaceState } from '../workspace/workspaceState';
import type { ReadingMaterial, SourceMetadata, StagedImport } from './material';
import { formatFromSourceFileName, type MaterialFormat } from './materialFormat';

/** 仅用于显式版本迁移候选筛选的临时匹配信号,不是材料身份或查重键。 */
export function metadataMatchKey(
  metadata: SourceMetadata,
  sourceFileName: string,
): string {
  const normalize = (value: string | null): string =>
    (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return JSON.stringify({
    format: formatFromSourceFileName(sourceFileName),
    title: normalize(metadata.title),
    author: normalize(metadata.author),
    language: normalize(metadata.language),
  });
}

export interface VersionMigrationCandidate {
  material: ReadingMaterial;
  staged: StagedImport;
  metadata: SourceMetadata;
}

/** 只有 EPUB 才进入该切片; PDF/Markdown 不会因元数据相似而进入迁移流程。 */
export function findVersionMigrationCandidates(
  materials: readonly ReadingMaterial[],
  staged: StagedImport,
  metadata: SourceMetadata,
): ReadingMaterial[] {
  if (formatFromSourceFileName(staged.originalFileName) !== 'epub') return [];
  const targetKey = metadataMatchKey(metadata, staged.originalFileName);
  return materials.filter(
    (material) =>
      formatFromSourceFileName(material.sourceFileName) === 'epub' &&
      material.fingerprint !== staged.fingerprint &&
      metadataMatchKey(material.source, material.sourceFileName) === targetKey,
  );
}

export type MigrationOutcome = 'kept' | 'reanchored' | 'orphaned';
export type MigrationItemKind = 'progress' | 'annotation';

export interface VersionMigrationPreviewItem {
  id: string;
  kind: MigrationItemKind;
  label: string;
  outcome: MigrationOutcome;
  oldCfi: string;
  newCfi: string | null;
  matchCount: number;
  reason?: TextAnchorRecoveryReason | 'unresolvable-position' | 'search-error';
  deleted?: boolean;
}

export interface VersionMigrationSummary {
  kept: number;
  reanchored: number;
  orphaned: number;
  total: number;
}

export interface VersionMigrationPreview {
  candidate: VersionMigrationCandidate;
  progress: VersionMigrationPreviewItem[];
  annotations: VersionMigrationPreviewItem[];
  summary: VersionMigrationSummary;
  /** 提交 seam 使用的完整新批注集合,包含 tombstone。 */
  migratedAnnotations: Annotation[];
  /** 提交 seam 使用的迁移后工作区状态。 */
  migratedWorkspaceState: WorkspaceState;
  /** 内存 Adapter 用于模拟恢复快照;Rust 会从 SQLite 一致快照读取旧数据。 */
  sourceAnnotations: Annotation[];
  sourceWorkspaceState: WorkspaceState;
}

export interface BuildVersionMigrationPreviewOptions {
  candidate: VersionMigrationCandidate;
  document: BookDocument;
  annotations: readonly Annotation[];
  deletedAnnotations: readonly Annotation[];
  workspaceState: WorkspaceState;
}

interface LocationMigration {
  outcome: MigrationOutcome;
  location: ReadingLocation | null;
  matchCount: number;
  reason?: 'unresolvable-position';
}

async function migrateLocation(
  document: BookDocument,
  location: ReadingLocation,
): Promise<LocationMigration> {
  if (location.kind !== 'epub' || !document.canResolveAnnotation) {
    return { outcome: 'orphaned', location: null, matchCount: 0, reason: 'unresolvable-position' };
  }
  try {
    if (await document.canResolveAnnotation(location.cfi)) {
      return { outcome: 'kept', location, matchCount: 1 };
    }
  } catch {
    // 不能安全确认位置时按孤儿处理,不把旧 CFI 静默留在新版本。
  }
  return { outcome: 'orphaned', location: null, matchCount: 0, reason: 'unresolvable-position' };
}

async function searchAnnotation(
  document: BookDocument,
  annotation: Annotation,
): Promise<ReturnType<typeof evaluateTextAnchorRecovery>> {
  const matches: TextAnchorSearchMatch[] = [];
  try {
    const generator = document.search({ query: annotation.anchor.quote, matchCase: true });
    for await (const event of generator) {
      if (event.kind === 'match') matches.push(event.match);
    }
  } finally {
    try {
      document.clearSearch();
    } catch {
      // 搜索高亮清理失败不改变明确的迁移结论。
    }
  }
  return evaluateTextAnchorRecovery(
    annotation.anchor,
    annotation.anchor.documentVersion,
    matches,
  );
}

async function migrateAnnotation(
  document: BookDocument,
  annotation: Annotation,
  targetFingerprint: string,
): Promise<{ item: VersionMigrationPreviewItem; annotation: Annotation }> {
  const baseItem = {
    id: annotation.id,
    kind: 'annotation' as const,
    label: annotation.note ? `批注：${annotation.note}` : `高亮：${annotation.anchor.quote}`,
    oldCfi: annotation.anchor.cfi,
    deleted: annotation.deletedAt !== null,
  };

  try {
    if (document.canResolveAnnotation && await document.canResolveAnnotation(annotation.anchor.cfi)) {
      const next = {
        ...annotation,
        anchor: {
          ...annotation.anchor,
          documentVersion: targetFingerprint,
          recoveryState: 'resolved' as const,
        },
      };
      return {
        item: { ...baseItem, outcome: 'kept', newCfi: next.anchor.cfi, matchCount: 1 },
        annotation: next,
      };
    }
  } catch {
    // 继续走唯一引文恢复;失败时会以孤儿结果保留原锚点。
  }

  let evaluation: ReturnType<typeof evaluateTextAnchorRecovery>;
  try {
    evaluation = await searchAnnotation(document, annotation);
  } catch {
    evaluation = {
      anchor: { ...annotation.anchor, recoveryState: 'orphaned' },
      outcome: 'orphaned',
      reason: 'zero-matches',
      matchCount: 0,
    };
    return {
      item: {
        ...baseItem,
        outcome: 'orphaned',
        newCfi: null,
        matchCount: 0,
        reason: 'search-error',
      },
      annotation: { ...annotation, anchor: evaluation.anchor },
    };
  }

  const nextAnchor =
    evaluation.outcome === 'orphaned'
      ? evaluation.anchor
      : { ...evaluation.anchor, documentVersion: targetFingerprint };
  return {
    item: {
      ...baseItem,
      outcome:
        evaluation.outcome === 'resolved' ? 'kept' : evaluation.outcome,
      newCfi: evaluation.outcome === 'orphaned' ? null : nextAnchor.cfi,
      matchCount: evaluation.matchCount,
      reason: evaluation.reason,
    },
    annotation: { ...annotation, anchor: nextAnchor },
  };
}

/**
 * 在新 EPUB BookDocument 上构造完整迁移预览。
 * 函数只读旧的 Workspace/Annotation 数据,不会写入任何 Repository。
 */
export async function buildVersionMigrationPreview(
  options: BuildVersionMigrationPreviewOptions,
): Promise<VersionMigrationPreview> {
  const { candidate, document, annotations, deletedAnnotations, workspaceState } = options;
  const progress: VersionMigrationPreviewItem[] = [];
  const migratedWorkspaceState = structuredClone(workspaceState);

  for (const group of migratedWorkspaceState.editorGroups) {
    for (const view of group.views) {
      if (view.materialId !== candidate.material.id) continue;
      const positions = view.history.positions;
      const currentLocation = view.location;
      const migratedPositions: ReadingLocation[] = [];
      let migratedCurrentIndex = -1;
      for (let index = 0; index < positions.length; index += 1) {
        const oldPosition = positions[index]!;
        const result = await migrateLocation(document, oldPosition);
        if (result.location) {
          migratedPositions.push(result.location);
          if (index === view.history.index) migratedCurrentIndex = migratedPositions.length - 1;
        }
        progress.push({
          id: `${view.id}:history:${index}`,
          kind: 'progress',
          label: `标签 ${view.id} 的阅读进度 ${index + 1}`,
          outcome: result.outcome,
          oldCfi:
            oldPosition.kind === 'epub' || oldPosition.kind === 'markdown'
              ? oldPosition.cfi
              : '',
          newCfi: result.location?.kind === 'epub' ? result.location.cfi : null,
          matchCount: result.matchCount,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }
      const nextIndex =
        migratedPositions.length === 0
          ? -1
          : migratedCurrentIndex >= 0
            ? migratedCurrentIndex
          : Math.min(
              Math.max(view.history.index, 0),
              migratedPositions.length - 1,
            );
      view.history = { positions: migratedPositions, index: nextIndex };
      view.location = nextIndex >= 0 ? migratedPositions[nextIndex]! : null;
      // Keep a current-location item for views that had no navigation history.
      if (positions.length === 0 && currentLocation) {
        const result = await migrateLocation(document, currentLocation);
        view.location = result.location;
        progress.push({
          id: `${view.id}:location`,
          kind: 'progress',
          label: `标签 ${view.id} 的当前阅读进度`,
          outcome: result.outcome,
          oldCfi:
            currentLocation.kind === 'epub' || currentLocation.kind === 'markdown'
              ? currentLocation.cfi
              : '',
          newCfi: result.location?.kind === 'epub' ? result.location.cfi : null,
          matchCount: result.matchCount,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }
    }
  }

  const sourceAnnotations = [...annotations, ...deletedAnnotations].map((item) => ({
    ...item,
    anchor: { ...item.anchor },
  }));
  const migratedAnnotations: Annotation[] = [];
  const annotationItems: VersionMigrationPreviewItem[] = [];
  for (const annotation of sourceAnnotations) {
    const result = await migrateAnnotation(document, annotation, candidate.staged.fingerprint);
    annotationItems.push(result.item);
    migratedAnnotations.push(result.annotation);
  }

  const allItems = [...progress, ...annotationItems];
  const summary = allItems.reduce<VersionMigrationSummary>(
    (current, item) => ({
      ...current,
      [item.outcome]: current[item.outcome] + 1,
      total: current.total + 1,
    }),
    { kept: 0, reanchored: 0, orphaned: 0, total: 0 },
  );

  return {
    candidate,
    progress,
    annotations: annotationItems,
    summary,
    migratedAnnotations,
    migratedWorkspaceState,
    sourceAnnotations,
    sourceWorkspaceState: structuredClone(workspaceState),
  };
}

export function isEpubVersionMigrationCandidate(
  candidate: VersionMigrationCandidate,
): boolean {
  return formatFromSourceFileName(candidate.staged.originalFileName) === 'epub';
}

export type VersionMigrationFormat = Extract<MaterialFormat, 'epub'>;
