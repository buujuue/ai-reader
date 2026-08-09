import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { ImportRepository } from '../domain/library/importRepository';
import type { ReadingMaterial } from '../domain/library/material';
import { formatFromSourceFileName } from '../domain/library/materialFormat';
import type { FoliateViewHostFactory } from '../domain/reader/foliateViewHost';
import { createFoliateViewHostFactory } from '../domain/reader/foliateViewHost';
import { MarkdownBookDocument } from '../domain/reader/markdown/markdownBookDocument';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { useLibraryStore } from './libraryStore';
import { useMarkdownSessionStore } from './markdownSessionStore';
import { useReaderRuntime } from './readerRuntime';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';
import { serializeWorkspaceState } from './workbenchCommands';
import { findView, getActiveViewId } from './viewUtils';

export interface MarkdownCommandDependencies {
  importRepository: ImportRepository;
  workspaceRepository: WorkspaceRepository;
  viewHostFactory?: FoliateViewHostFactory;
}

/** 判断一个视图是否为 Markdown 阅读视图(仅 Markdown 支持源码模式)。 */
function isMarkdownView(viewId: string): boolean {
  const view = findView(viewId);
  if (!view) return false;
  const material = useLibraryStore
    .getState()
    .materials.find((material) => material.id === view.materialId);
  if (!material) return false;
  return formatFromSourceFileName(material.sourceFileName) === 'markdown';
}

/** 读取某材料的会话;无会话时返回 null。 */
function getSession(materialId: string) {
  return useMarkdownSessionStore.getState().getSession(materialId);
}

/**
 * 保存/放弃后重建该材料所有视图的 MarkdownBookDocument,使阅读模式视图显示新内容。
 * 源码模式视图也会重建其文档,以便退出源码模式后立即呈现新内容。
 * 缓存位置仍在 Workspace Store,ReadingView 挂载时按位置恢复。
 */
async function rebuildMarkdownDocuments(
  material: ReadingMaterial,
  dependencies: MarkdownCommandDependencies,
): Promise<void> {
  const bytes = await dependencies.importRepository.readManagedFile(material.id);
  const text = new TextDecoder('utf-8').decode(bytes);
  const runtime = useReaderRuntime.getState();
  const state = useWorkspaceStore.getState();
  const viewIds = state.editorGroups
    .flatMap((group) => group.views)
    .filter((view) => view.materialId === material.id)
    .map((view) => view.id);
  const factory = dependencies.viewHostFactory ?? createFoliateViewHostFactory();
  for (const viewId of viewIds) {
    const existing = runtime.documents.get(viewId);
    existing?.close();
    runtime.setDocument(
      viewId,
      new MarkdownBookDocument({
        text,
        metadata: {
          title: material.title,
          author: material.author,
          language: material.language,
        },
        viewHostFactory: factory,
      }),
    );
  }
}

export function registerMarkdownCommands(
  registry: CommandRegistry,
  dependencies: MarkdownCommandDependencies,
): void {
  registry.register(COMMAND_IDS.markdownToggleSourceMode, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId || !isMarkdownView(viewId)) return;
    const view = findView(viewId);
    if (!view) return;

    const next = !view.sourceMode;
    if (view.sourceMode && !next) {
      // 退出源码模式:若会话脏,先询问保存/放弃/取消。
      const session = getSession(view.materialId);
      if (session?.dirty) {
        useShellUiStore.getState().openMarkdownDirtyClose(viewId, 'exitSource');
        return;
      }
    }

    useWorkspaceStore.getState().setViewSourceMode(viewId, next);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.markdownSave, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId || !isMarkdownView(viewId)) return;
    const view = findView(viewId);
    if (!view) return;
    const session = getSession(view.materialId);
    if (!session) return;

    try {
      const updated = await dependencies.importRepository.saveMarkdown(
        view.materialId,
        session.text,
      );
      useMarkdownSessionStore.getState().markSaved(view.materialId, updated.documentVersion);
      useLibraryStore.getState().updateMaterial(updated);
      await rebuildMarkdownDocuments(updated, dependencies);
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
      useShellUiStore
        .getState()
        .setStatusMessage('已保存 Markdown,文档版本已更新');
    } catch (error) {
      useShellUiStore.getState().setStatusMessage('保存 Markdown 失败');
      throw error;
    }
  });

  registry.register(COMMAND_IDS.markdownDiscard, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId || !isMarkdownView(viewId)) return;
    const view = findView(viewId);
    if (!view) return;
    const session = getSession(view.materialId);
    if (!session) return;

    const bytes = await dependencies.importRepository.readManagedFile(view.materialId);
    const savedText = new TextDecoder('utf-8').decode(bytes);
    useMarkdownSessionStore.getState().discard(view.materialId, savedText);
    await rebuildMarkdownDocuments(
      useLibraryStore
        .getState()
        .materials.find((material) => material.id === view.materialId)!,
      dependencies,
    );
    useShellUiStore.getState().setStatusMessage('已放弃未保存的 Markdown 修改');
  });

  registry.register(COMMAND_IDS.markdownCloseDirty, async (...args: unknown[]) => {
    const viewId = args[0] as string | undefined;
    const choice = args[1] as 'save' | 'discard' | 'cancel' | undefined;
    if (!viewId || !choice || choice === 'cancel') {
      useShellUiStore.getState().closeMarkdownDirtyClose();
      return;
    }
    const view = findView(viewId);
    const action = useShellUiStore.getState().markdownDirtyCloseAction;
    if (!view) {
      useShellUiStore.getState().closeMarkdownDirtyClose();
      return;
    }

    if (choice === 'save') {
      const session = getSession(view.materialId);
      if (session) {
        try {
          const updated = await dependencies.importRepository.saveMarkdown(
            view.materialId,
            session.text,
          );
          useMarkdownSessionStore.getState().markSaved(view.materialId, updated.documentVersion);
          useLibraryStore.getState().updateMaterial(updated);
          await rebuildMarkdownDocuments(updated, dependencies);
        } catch {
          useShellUiStore.getState().closeMarkdownDirtyClose();
          useShellUiStore.getState().setStatusMessage('保存 Markdown 失败,未关闭');
          return;
        }
      }
    } else {
      const bytes = await dependencies.importRepository.readManagedFile(view.materialId);
      const savedText = new TextDecoder('utf-8').decode(bytes);
      useMarkdownSessionStore.getState().discard(view.materialId, savedText);
    }

    useShellUiStore.getState().closeMarkdownDirtyClose();
    if (action === 'exitSource') {
      useWorkspaceStore.getState().setViewSourceMode(viewId, false);
    } else {
      await registry.execute(COMMAND_IDS.readerCloseView, viewId);
    }
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });
}