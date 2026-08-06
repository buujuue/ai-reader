import { COMMAND_IDS } from '../commands/commandRegistry';
import type { CommandRegistry } from '../commands/commandRegistry';
import type { BookDocument } from '../domain/reader/bookDocument';
import { EpubBookDocument } from '../domain/reader/epubBookDocument';
import {
  createFoliateViewHostFactory,
  type FoliateViewHostFactory,
} from '../domain/reader/foliateViewHost';
import { inspectEpub } from '../domain/library/epub/epubInspector';
import type { ImportRepository } from '../domain/library/importRepository';
import type { ReadingMaterial } from '../domain/library/material';
import type { ReadingLocation } from '../domain/reader/readingLocation';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { ThrottledPositionPersister } from './positionPersister';
import { useReaderRuntime } from './readerRuntime';
import { useWorkspaceStore } from './workspaceStore';
import { serializeWorkspaceState } from './workbenchCommands';

export interface ReaderCommandDependencies {
  importRepository: ImportRepository;
  workspaceRepository: WorkspaceRepository;
  viewHostFactory?: FoliateViewHostFactory;
}

/**
 * 阅读位置持久化器注册表(活对象,不进入持久化状态)。
 * 每个打开中的阅读视图对应一个节流写入器,关闭时强制 flush。
 */
const persisters = new Map<string, ThrottledPositionPersister>();

function getActiveViewId(): string | null {
  const state = useWorkspaceStore.getState();
  const group = state.editorGroups.find((group) => group.id === state.activeEditorGroupId);
  return group?.activeViewId ?? null;
}

/**
 * 读取并检查托管 EPUB 字节,构造 BookDocument。
 * 返回 null 表示材料不是可读的 EPUB。
 */
async function createEpubDocument(
  dependencies: ReaderCommandDependencies,
  material: ReadingMaterial,
): Promise<BookDocument | null> {
  const bytes = await dependencies.importRepository.readManagedFile(material.id);
  let metadata;
  try {
    const result = await inspectEpub(bytes);
    metadata = result.metadata;
  } catch {
    return null;
  }
  return new EpubBookDocument({
    bytes,
    metadata,
    viewHostFactory: dependencies.viewHostFactory ?? createFoliateViewHostFactory(),
  });
}

/**
 * 交给 ReadingView 组件在自身容器内挂载 BookDocument,并接线位置持久化。
 * 返回持久化器,组件卸载时应 dispose。
 */
export function mountViewDocument(
  document: BookDocument,
  viewId: string,
  container: HTMLElement,
  location: ReadingLocation | null,
  dependencies: ReaderCommandDependencies,
): ThrottledPositionPersister {
  const persister = new ThrottledPositionPersister({
    save: async (next) => {
      useWorkspaceStore.getState().setViewLocation(viewId, next);
      try {
        await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
      } catch (error) {
        console.error('保存阅读位置失败', error);
      }
    },
  });
  persisters.set(viewId, persister);
  document.onLocationChange((next) => persister.update(next));

  void document.open(container)
    .then(() => {
      if (location) {
        void document.goToLocation(location);
      }
    })
    .catch((error: unknown) => {
      console.error('打开阅读文档失败', error);
    });

  return persister;
}

export function registerReaderCommands(
  registry: CommandRegistry,
  dependencies: ReaderCommandDependencies,
): void {
  registry.register(COMMAND_IDS.libraryOpenBook, async (...args: unknown[]) => {
    const material = args[0] as ReadingMaterial | undefined;
    const location = (args[1] as ReadingLocation | null | undefined) ?? null;
    if (!material) {
      throw new Error('打开书籍命令缺少阅读材料参数');
    }
    const viewId = useWorkspaceStore.getState().openView(material.id);
    try {
      const document = await createEpubDocument(dependencies, material);
      if (!document) {
        useWorkspaceStore.getState().closeView(viewId);
        throw new Error(`无法打开阅读材料:${material.title}`);
      }
      useReaderRuntime.getState().setDocument(viewId, document);
      if (location) {
        useWorkspaceStore.getState().setViewLocation(viewId, location);
      }
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
    } catch (error) {
      useWorkspaceStore.getState().closeView(viewId);
      throw error;
    }
  });

  registry.register(COMMAND_IDS.readerNextPage, async () => {
    const viewId = getActiveViewId();
    if (!viewId) return;
    await useReaderRuntime.getState().getDocument(viewId)?.next();
  });

  registry.register(COMMAND_IDS.readerPrevPage, async () => {
    const viewId = getActiveViewId();
    if (!viewId) return;
    await useReaderRuntime.getState().getDocument(viewId)?.prev();
  });

  registry.register(COMMAND_IDS.readerCloseView, async (...args: unknown[]) => {
    const viewIdParam = args[0] as string | undefined;
    const targetId = viewIdParam ?? getActiveViewId();
    if (!targetId) return;

    const persister = persisters.get(targetId);
    if (persister) {
      await persister.dispose();
      persisters.delete(targetId);
    }
    useReaderRuntime.getState().removeDocument(targetId);
    useWorkspaceStore.getState().closeView(targetId);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerRestoreView, async (...args: unknown[]) => {
    const viewId = args[0] as string | undefined;
    const material = args[1] as ReadingMaterial | undefined;
    const location = (args[2] as ReadingLocation | null | undefined) ?? null;
    if (!viewId || !material) return;

    const document = await createEpubDocument(dependencies, material);
    if (!document) return;
    useReaderRuntime.getState().setDocument(viewId, document);
    if (location) {
      useWorkspaceStore.getState().setViewLocation(viewId, location);
    }
  });
}

/** 应用关闭时把所有视图的位置 flush 并关闭渲染器。 */
export async function flushAndCloseAllReaderViews(): Promise<void> {
  for (const persister of persisters.values()) {
    await persister.dispose();
  }
  persisters.clear();
  useReaderRuntime.getState().closeAll();
}