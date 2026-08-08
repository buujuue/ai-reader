import { describe, expect, it } from 'vitest';

import type { TauriInvoke } from '../tauriInvoke';
import type { Annotation } from './annotation';
import { annotationRepositoryContract } from './annotationRepository.contract';
import {
  createTauriAnnotationRepository,
  ANNOTATION_COMMAND_NAMES,
} from './tauriAnnotationRepository';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-1',
    materialId: 'material-1',
    anchor: {
      cfi: 'epubcfi(/6/4[chap])!/4/2/2/1:0',
      quote: '被选中的文字',
      before: '前文',
      after: '后文',
      documentVersion: 'fingerprint-1',
      recoveryState: 'resolved',
    },
    style: 'highlight',
    color: '#ffd54f',
    note: '',
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...overrides,
  };
}

/** 模拟 Rust 端 typed annotation 命令:snake_case 命令名、serde camelCase DTO、按 materialId 归属。 */
function createFakeTauriBackend(): {
  invoke: TauriInvoke;
} {
  const store = new Map<string, Annotation>();
  const invoke: TauriInvoke = async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case ANNOTATION_COMMAND_NAMES.list: {
        const materialId = (args as { materialId?: unknown }).materialId as string;
        return [...store.values()]
          .filter((annotation) => annotation.materialId === materialId && annotation.deletedAt === null)
          .sort((a, b) => a.createdAt - b.createdAt);
      }
      case ANNOTATION_COMMAND_NAMES.save: {
        const annotation = (args as { annotation?: unknown }).annotation as Annotation;
        store.set(annotation.id, { ...annotation });
        return { ...annotation };
      }
      case ANNOTATION_COMMAND_NAMES.delete: {
        const annotationId = (args as { annotationId?: unknown }).annotationId as string;
        const annotation = store.get(annotationId);
        if (annotation) {
          store.set(annotationId, { ...annotation, deletedAt: Date.now() });
        }
        return null;
      }
      default:
        throw new Error(`unknown tauri command: ${command}`);
    }
  };
  return { invoke };
}

describe('AnnotationRepository 契约 · Tauri Adapter', () => {
  annotationRepositoryContract(() =>
    createTauriAnnotationRepository(createFakeTauriBackend().invoke),
  );
});

describe('TauriAnnotationRepository 边界映射', () => {
  it('使用稳定的 snake_case Tauri 命令名', () => {
    expect(ANNOTATION_COMMAND_NAMES.list).toBe('list_annotations');
    expect(ANNOTATION_COMMAND_NAMES.save).toBe('save_annotation');
    expect(ANNOTATION_COMMAND_NAMES.delete).toBe('delete_annotation');
  });

  it('列出批注时把 materialId 放入 serde 期望的参数', async () => {
    let received: Record<string, unknown> | undefined;
    const invoke: TauriInvoke = async (_command, args) => {
      received = args;
      return [];
    };
    const repository = createTauriAnnotationRepository(invoke);

    await repository.listByMaterial('material-1');

    expect(received).toEqual({ materialId: 'material-1' });
  });

  it('保存批注时把 annotation 放入参数', async () => {
    let received: Record<string, unknown> | undefined;
    const invoke: TauriInvoke = async (_command, args) => {
      received = args;
      return makeAnnotation();
    };
    const repository = createTauriAnnotationRepository(invoke);
    const annotation = makeAnnotation();

    await repository.saveAnnotation(annotation);

    expect(received?.annotation).toEqual(annotation);
  });

  it('后端返回异常结构时拒绝加载', async () => {
    const invoke: TauriInvoke = async () => ({ id: 42 });

    const repository = createTauriAnnotationRepository(invoke);

    await expect(repository.listByMaterial('material-1')).rejects.toThrow();
    await expect(repository.saveAnnotation(makeAnnotation())).rejects.toThrow();
  });
});