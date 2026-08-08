import { invoke } from '@tauri-apps/api/core';

import type { TauriInvoke } from '../tauriInvoke';
import type { Annotation } from './annotation';
import type { AnnotationRepository } from './annotationRepository';

export const ANNOTATION_COMMAND_NAMES = {
  list: 'list_annotations',
  save: 'save_annotation',
  delete: 'delete_annotation',
} as const;

function assertAnnotationShape(raw: unknown): Annotation {
  const candidate = raw as Partial<Annotation> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.id !== 'string' ||
    typeof candidate.materialId !== 'string' ||
    typeof candidate.style !== 'string' ||
    typeof candidate.color !== 'string' ||
    typeof candidate.note !== 'string' ||
    typeof candidate.createdAt !== 'number' ||
    typeof candidate.updatedAt !== 'number'
  ) {
    throw new Error('annotation payload is malformed');
  }
  const anchor = candidate.anchor as Partial<Annotation['anchor']> | null;
  if (
    typeof anchor !== 'object' ||
    anchor === null ||
    typeof anchor.cfi !== 'string' ||
    typeof anchor.quote !== 'string' ||
    typeof anchor.before !== 'string' ||
    typeof anchor.after !== 'string' ||
    typeof anchor.documentVersion !== 'string' ||
    (anchor.recoveryState !== 'resolved' && anchor.recoveryState !== 'orphaned')
  ) {
    throw new Error('annotation anchor payload is malformed');
  }
  return {
    id: candidate.id,
    materialId: candidate.materialId,
    anchor: {
      cfi: anchor.cfi,
      quote: anchor.quote,
      before: anchor.before,
      after: anchor.after,
      documentVersion: anchor.documentVersion,
      recoveryState: anchor.recoveryState,
    },
    style: candidate.style as Annotation['style'],
    color: candidate.color,
    note: candidate.note,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    deletedAt: candidate.deletedAt ?? null,
  };
}

function assertAnnotationList(raw: unknown): Annotation[] {
  if (!Array.isArray(raw)) {
    throw new Error('annotations payload is not an array');
  }
  return raw.map(assertAnnotationShape);
}

export function createTauriAnnotationRepository(invokeFn: TauriInvoke): AnnotationRepository {
  return {
    async listByMaterial(materialId: string): Promise<Annotation[]> {
      const raw = await invokeFn(ANNOTATION_COMMAND_NAMES.list, { materialId });
      return assertAnnotationList(raw);
    },
    async saveAnnotation(annotation: Annotation): Promise<Annotation> {
      const raw = await invokeFn(ANNOTATION_COMMAND_NAMES.save, { annotation });
      return assertAnnotationShape(raw);
    },
    async deleteAnnotation(annotationId: string): Promise<void> {
      await invokeFn(ANNOTATION_COMMAND_NAMES.delete, { annotationId });
    },
  };
}

export function createDefaultTauriAnnotationRepository(): AnnotationRepository {
  return createTauriAnnotationRepository((command, args) => invoke(command, args));
}