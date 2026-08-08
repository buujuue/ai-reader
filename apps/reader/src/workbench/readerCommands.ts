import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { ExternalUrlOpener } from '../app/externalUrlOpener';
import type { BookDocument } from '../domain/reader/bookDocument';
import { EpubBookDocument } from '../domain/reader/epubBookDocument';
import {
  createFoliateViewHostFactory,
  type FoliateViewHostFactory,
} from '../domain/reader/foliateViewHost';
import { back as historyBack, forward as historyForward } from '../domain/reader/navigationHistory';
import { inspectEpub } from '../domain/library/epub/epubInspector';
import type { ImportRepository } from '../domain/library/importRepository';
import type { ReadingMaterial } from '../domain/library/material';
import type { ReadingLocation } from '../domain/reader/readingLocation';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { ThrottledPositionPersister } from './positionPersister';
import { useReaderRuntime } from './readerRuntime';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';
import { serializeWorkspaceState } from './workbenchCommands';

export interface ReaderCommandDependencies {
  importRepository: ImportRepository;
  workspaceRepository: WorkspaceRepository;
  viewHostFactory?: FoliateViewHostFactory;
  externalUrlOpener?: ExternalUrlOpener;
}

/**
 * 阅读位置持久化器注册表(活对象,不进入持久化状态)。
 * 每个打开中的阅读视图对应一个节流写入器,关闭时强制 flush。
 */
const persisters = new Map<string, ThrottledPositionPersister>();

/**
 * 每个阅读视图的"本次导航意图"。普通翻页/滚动用 `replace`;显式跳转用 `push`。
 * 它决定下一次 relocate 时当前历史节点是被替换还是新增。
 * 这是活对象,不进入持久化状态。
 */
const navigationIntents = new Map<string, 'replace' | 'push'>();

function getActiveViewId(): string | null {
  const state = useWorkspaceStore.getState();
  const group = state.editorGroups.find((group) => group.id === state.activeEditorGroupId);
  return group?.activeViewId ?? null;
}

function findView(viewId: string) {
  const state = useWorkspaceStore.getState();
  for (const group of state.editorGroups) {
    const view = group.views.find((view) => view.id === viewId);
    if (view) return view;
  }
  return undefined;
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
 * 交给 ReadingView 组件在自身容器内挂载 BookDocument,并接线位置持久化与导航历史。
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

  // 位置变化:按本次导航意图更新当前阅读位置与导航历史。
  document.onLocationChange((next) => {
    const intent = navigationIntents.get(viewId) ?? 'replace';
    navigationIntents.delete(viewId);
    if (intent === 'push') {
      useWorkspaceStore.getState().pushViewLocation(viewId, next);
    } else {
      useWorkspaceStore.getState().setViewLocation(viewId, next);
    }
    persister.update(next);
  });

  // 书内链接:显式跳转,压入历史节点。
  document.onInternalLink((href) => {
    navigationIntents.set(viewId, 'push');
    void document.goToHref(href).catch((error: unknown) => {
      console.error('书内链接导航失败', error);
    });
  });

  // 外部链接:先展示目标,经用户确认后由统一 Command 交给系统浏览器。
  // 阅读 WebView 自身不导航到外部站点(宿主已 preventDefault)。
  document.onExternalLink((href) => {
    useShellUiStore.getState().openExternalLinkConfirm(href);
  });

  void document.open(container)
    .then(() => {
      if (location) {
        navigationIntents.set(viewId, 'replace');
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
    navigationIntents.set(viewId, 'replace');
    await useReaderRuntime.getState().getDocument(viewId)?.next();
  });

  registry.register(COMMAND_IDS.readerPrevPage, async () => {
    const viewId = getActiveViewId();
    if (!viewId) return;
    navigationIntents.set(viewId, 'replace');
    await useReaderRuntime.getState().getDocument(viewId)?.prev();
  });

  registry.register(COMMAND_IDS.readerGoToHref, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const href = args[1] as string | undefined;
    if (!viewId || !href) return;
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!document) return;
    navigationIntents.set(viewId, 'push');
    await document.goToHref(href);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerBack, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    const view = findView(viewId);
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!view || !document) return;
    const step = historyBack(view.history);
    if (!step) return;
    useWorkspaceStore.getState().setViewHistory(viewId, step.history);
    navigationIntents.set(viewId, 'replace');
    await document.goToLocation(step.location);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerForward, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    const view = findView(viewId);
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!view || !document) return;
    const step = historyForward(view.history);
    if (!step) return;
    useWorkspaceStore.getState().setViewHistory(viewId, step.history);
    navigationIntents.set(viewId, 'replace');
    await document.goToLocation(step.location);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerOpenExternalUrl, async (...args: unknown[]) => {
    const url = args[0] as string | undefined;
    if (!url || !dependencies.externalUrlOpener) {
      return;
    }
    // 只把 http/https 交给系统浏览器,拦截其它 scheme(样本清洗已移除危险 URL,
    // 这里作为纵深防线,避免把 file:// 等交给系统处理)。
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return;
    }
    await dependencies.externalUrlOpener.open(url);
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
    navigationIntents.delete(targetId);
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
  navigationIntents.clear();
  useReaderRuntime.getState().closeAll();
}