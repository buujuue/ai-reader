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
import { findView, getActiveViewId, isViewActive } from './viewUtils';
import { readManagedMarkdownText } from './markdownSource';

export interface MarkdownCommandDependencies {
  importRepository: ImportRepository;
  workspaceRepository: WorkspaceRepository;
  viewHostFactory?: FoliateViewHostFactory;
}

const RECOVERY_WRITE_DELAY_MS = 1_000;

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
 * 保存/放弃后重建该材料仍在 Runtime 中的活动 MarkdownBookDocument,使阅读模式视图显示新内容。
 * 非活动标签没有渲染器，不在这里创建新 Runtime；重新激活时由 Reader Command 按保存位置重建。
 * 缓存位置仍在 Workspace Store,ReadingView 挂载时按位置恢复。
 */
async function rebuildMarkdownDocuments(
  material: ReadingMaterial,
  dependencies: MarkdownCommandDependencies,
): Promise<void> {
  const text = await readManagedMarkdownText(dependencies.importRepository, material.id);
  const runtime = useReaderRuntime.getState();
  const state = useWorkspaceStore.getState();
  const viewIds = state.editorGroups
    .flatMap((group) => group.views)
    .filter((view) => view.materialId === material.id)
    .map((view) => view.id);
  const factory = dependencies.viewHostFactory ?? createFoliateViewHostFactory();
  for (const viewId of viewIds) {
    if (!isViewActive(viewId)) continue;
    const existing = runtime.documents.get(viewId);
    if (!existing) continue;
    existing.close();
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
        sourceFingerprint: material.fingerprint,
      }),
    );
  }
}

export function registerMarkdownCommands(
  registry: CommandRegistry,
  dependencies: MarkdownCommandDependencies,
): void {
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const recoveryWrites = new Map<string, Promise<void>>();

  function enqueueRecoveryWrite(
    materialId: string,
    content: string,
    baseDocumentVersion: number,
  ): Promise<void> {
    const previous = recoveryWrites.get(materialId) ?? Promise.resolve();
    const write = previous
      .then(() =>
        dependencies.importRepository.writeMarkdownRecovery(
          materialId,
          content,
          baseDocumentVersion,
        ),
      )
      .catch(() => {
        useShellUiStore
          .getState()
          .setStatusMessage('Markdown 恢复快照写入失败,正式材料仍可继续使用');
      })
      .finally(() => {
        if (recoveryWrites.get(materialId) === write) {
          recoveryWrites.delete(materialId);
        }
      });
    recoveryWrites.set(materialId, write);
    return write;
  }

  function scheduleRecoveryWrite(materialId: string): void {
    if (recoveryTimers.has(materialId)) return;
    recoveryTimers.set(
      materialId,
      setTimeout(() => {
        recoveryTimers.delete(materialId);
        const session = getSession(materialId);
        if (!session?.dirty) return;
        void enqueueRecoveryWrite(materialId, session.text, session.savedVersion);
      }, RECOVERY_WRITE_DELAY_MS),
    );
  }

  async function settleRecoveryWrite(materialId: string): Promise<void> {
    const timer = recoveryTimers.get(materialId);
    if (timer) {
      clearTimeout(timer);
      recoveryTimers.delete(materialId);
    }
    await recoveryWrites.get(materialId);
  }

  async function flushRecoveryWrite(materialId: string): Promise<void> {
    await settleRecoveryWrite(materialId);
    const session = getSession(materialId);
    if (!session?.dirty) return;
    await enqueueRecoveryWrite(materialId, session.text, session.savedVersion);
  }

  async function clearRecoverySnapshot(materialId: string): Promise<boolean> {
    try {
      await dependencies.importRepository.discardMarkdownRecovery(materialId);
      return true;
    } catch {
      useShellUiStore
        .getState()
        .setStatusMessage('Markdown 已处理,但恢复快照清理失败;下次启动会提示冲突');
      return false;
    }
  }

  async function saveMarkdownSession(materialId: string): Promise<{
    bufferUnchanged: boolean;
    recoveryCleared: boolean;
  } | null> {
    const session = getSession(materialId);
    if (!session) return null;
    await settleRecoveryWrite(materialId);
    const savedText = session.text;
    const updated = await dependencies.importRepository.saveMarkdown(materialId, savedText);
    let bufferUnchanged = useMarkdownSessionStore
      .getState()
      .recordFormalSave(materialId, savedText, updated.documentVersion);
    useLibraryStore.getState().updateMaterial(updated);

    let recoveryCleared = false;
    if (bufferUnchanged) {
      recoveryCleared = await clearRecoverySnapshot(materialId);
    } else {
      await flushRecoveryWrite(materialId);
    }
    await rebuildMarkdownDocuments(updated, dependencies);

    if (bufferUnchanged && getSession(materialId)?.dirty) {
      bufferUnchanged = false;
      await flushRecoveryWrite(materialId);
    }
    return { bufferUnchanged, recoveryCleared };
  }

  registry.register(COMMAND_IDS.markdownUpdateBuffer, async (...args: unknown[]) => {
    const viewId = args[0] as string | undefined;
    const text = args[1] as string | undefined;
    if (!viewId || typeof text !== 'string' || !isMarkdownView(viewId)) return;
    const view = findView(viewId);
    if (!view) return;
    useMarkdownSessionStore.getState().updateText(view.materialId, text);
    scheduleRecoveryWrite(view.materialId);
  });

  registry.register(COMMAND_IDS.markdownCheckRecoveries, async () => {
    try {
      const snapshots = await dependencies.importRepository.listMarkdownRecoveries();
      useShellUiStore.getState().setMarkdownRecoverySnapshots(snapshots);
      if (snapshots.some((snapshot) => snapshot.status === 'corrupt')) {
        useShellUiStore
          .getState()
          .setStatusMessage('发现损坏的 Markdown 恢复快照,正式材料未受影响');
      }
    } catch {
      useShellUiStore
        .getState()
        .setStatusMessage('检查 Markdown 恢复快照失败,正式材料仍可继续使用');
    }
  });

  registry.register(COMMAND_IDS.markdownResolveRecovery, async (...args: unknown[]) => {
    const materialId = args[0] as string | undefined;
    const choice = args[1] as 'restore' | 'discard' | undefined;
    if (!materialId || !choice) return;
    const snapshot = useShellUiStore
      .getState()
      .markdownRecoverySnapshots.find((candidate) => candidate.materialId === materialId);
    if (!snapshot) return;

    if (choice === 'restore') {
      if (snapshot.content === null) return;
      const materials = await dependencies.importRepository.listMaterials();
      const material = materials.find((candidate) => candidate.id === materialId);
      if (!material) return;
      useMarkdownSessionStore
        .getState()
        .restoreRecovery(materialId, snapshot.content, material.documentVersion);
      useShellUiStore.getState().removeMarkdownRecoverySnapshot(materialId);
      useShellUiStore
        .getState()
        .setStatusMessage(
          snapshot.status === 'conflict'
            ? '已载入冲突快照为未保存内容,请核对后再保存'
            : '已恢复未保存的 Markdown 内容',
        );
      return;
    }

    await settleRecoveryWrite(materialId);
    if (await clearRecoverySnapshot(materialId)) {
      useShellUiStore.getState().removeMarkdownRecoverySnapshot(materialId);
      useShellUiStore.getState().setStatusMessage('已丢弃 Markdown 恢复快照');
    }
  });

  registry.register(COMMAND_IDS.markdownFlushRecoveries, async () => {
    const materialIds = Object.values(useMarkdownSessionStore.getState().sessions)
      .filter((session) => session.dirty)
      .map((session) => session.materialId);
    await Promise.all(materialIds.map(flushRecoveryWrite));
  });

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
    try {
      const result = await saveMarkdownSession(view.materialId);
      if (!result) return;
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
      useShellUiStore
        .getState()
        .setStatusMessage(
          !result.bufferUnchanged
            ? 'Markdown 已保存,编辑期间的新修改仍为未保存内容并已写入恢复快照'
            : result.recoveryCleared
            ? '已保存 Markdown,文档版本已更新'
            : '已保存 Markdown,但恢复快照清理失败;下次启动会提示冲突',
        );
    } catch (error) {
      await flushRecoveryWrite(view.materialId);
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

    await settleRecoveryWrite(view.materialId);
    const savedText = await readManagedMarkdownText(
      dependencies.importRepository,
      view.materialId,
    );
    useMarkdownSessionStore.getState().discard(view.materialId, savedText);
    const recoveryCleared = await clearRecoverySnapshot(view.materialId);
    await rebuildMarkdownDocuments(
      useLibraryStore
        .getState()
        .materials.find((material) => material.id === view.materialId)!,
      dependencies,
    );
    useShellUiStore
      .getState()
      .setStatusMessage(
        recoveryCleared
          ? '已放弃未保存的 Markdown 修改'
          : '已放弃修改,但恢复快照清理失败;下次启动仍会提示',
      );
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
      try {
        const result = await saveMarkdownSession(view.materialId);
        if (result && !result.bufferUnchanged) {
          useShellUiStore.getState().closeMarkdownDirtyClose();
          useShellUiStore
            .getState()
            .setStatusMessage('Markdown 已保存,但编辑期间有新修改,未关闭');
          return;
        }
      } catch {
        await flushRecoveryWrite(view.materialId);
        useShellUiStore.getState().closeMarkdownDirtyClose();
        useShellUiStore.getState().setStatusMessage('保存 Markdown 失败,未关闭');
        return;
      }
    } else {
      await settleRecoveryWrite(view.materialId);
      const savedText = await readManagedMarkdownText(
        dependencies.importRepository,
        view.materialId,
      );
      useMarkdownSessionStore.getState().discard(view.materialId, savedText);
      await clearRecoverySnapshot(view.materialId);
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
