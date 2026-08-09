import { useEffect } from 'react';

import { ActivityBar } from '../components/ActivityBar';
import { EditorArea } from '../components/EditorArea';
import { ExternalLinkDialog } from '../components/ExternalLinkDialog';
import { MarkdownDirtyCloseDialog } from '../components/MarkdownDirtyCloseDialog';
import { MarkdownRecoveryDialog } from '../components/MarkdownRecoveryDialog';
import { MetadataEditorDialog } from '../components/MetadataEditorDialog';
import { NoteEditorDialog } from '../components/NoteEditorDialog';
import { PrimarySidebar } from '../components/PrimarySidebar';
import { PurgeConfirmDialog } from '../components/PurgeConfirmDialog';
import { ReaderSettingsDialog } from '../components/ReaderSettingsDialog';
import { StatusBar } from '../components/StatusBar';
import { TocSidebar } from '../components/TocSidebar';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { useAppServices } from './AppServicesContext';

export function App() {
  const { commands, workspaceRepository, importRepository, windowLifecycle } = useAppServices();
  const primarySidebarVisible = useWorkspaceStore((state) => state.primarySidebarVisible);
  const tocVisible = useShellUiStore((state) => state.tocVisible);

  useEffect(() => {
    let cancelled = false;
    workspaceRepository
      .loadState()
      .then(async (state) => {
        if (!cancelled) {
          useWorkspaceStore.getState().hydrate(state);
          await commands.execute(COMMAND_IDS.libraryRefresh);
          await restoreViews();
          if (!cancelled) {
            await commands.execute(COMMAND_IDS.markdownCheckRecoveries);
          }
        }
      })
      .catch(async (error: unknown) => {
        console.error('恢复工作区状态失败', error);
        useShellUiStore.getState().setStatusMessage('恢复工作区状态失败');
        if (!cancelled) {
          await commands.execute(COMMAND_IDS.libraryRefresh).catch(() => undefined);
          await commands.execute(COMMAND_IDS.markdownCheckRecoveries).catch(() => undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [commands, workspaceRepository]);

  // 桌面端先阻止窗口关闭,等待恢复快照与阅读位置落盘后再销毁窗口。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const flushRuntime = async () => {
      await commands.execute(COMMAND_IDS.markdownFlushRecoveries);
      const { flushAndCloseAllReaderViews } = await import('../workbench/readerCommands');
      await flushAndCloseAllReaderViews();
    };
    if (windowLifecycle) {
      void windowLifecycle
        .onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await flushRuntime();
          } finally {
            await windowLifecycle.destroy();
          }
        })
        .then((dispose) => {
          if (disposed) dispose();
          else unlisten = dispose;
        })
        .catch(console.error);
    }

    const flushBestEffort = () => {
      void flushRuntime().catch(() => undefined);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushBestEffort();
    };
    window.addEventListener('pagehide', flushBestEffort);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener('pagehide', flushBestEffort);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      flushBestEffort();
    };
  }, [commands, windowLifecycle]);

  // Ctrl+F(Windows/Linux)或 Cmd+F(macOS)在当前激活阅读视图内打开搜索。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        // 焦点在输入控件(如书库筛选、元数据编辑器)时不抢占,交给该控件自身。
        const target = event.target as HTMLElement | null;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        event.preventDefault();
        void commands.execute(COMMAND_IDS.readerSearchOpen).catch(() => undefined);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commands]);

  // 重启恢复:为持久化的标签重建 BookDocument 并恢复其阅读位置。
  async function restoreViews() {
    const materials = await importRepository.listMaterials();
    const state = useWorkspaceStore.getState();
    const group = state.editorGroups.find((candidate) => candidate.id === state.activeEditorGroupId);
    if (!group) return;

    const activeView = group.views.find((view) => view.id === group.activeViewId);
    const fallbackView =
      (activeView && materials.some((material) => material.id === activeView.materialId)
        ? activeView
        : null) ??
      group.views.find((view) => materials.some((material) => material.id === view.materialId));
    if (!fallbackView) return;

    const material = materials.find((candidate) => candidate.id === fallbackView.materialId);
    if (!material) return;
    await commands
      .execute(COMMAND_IDS.readerActivateView, fallbackView.id, material)
      .catch((error: unknown) => {
        console.error('恢复阅读视图失败', error);
      });
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        {tocVisible ? <TocSidebar /> : null}
        {primarySidebarVisible ? <PrimarySidebar /> : null}
        <EditorArea />
      </div>
      <StatusBar />
      <MetadataEditorDialog />
      <MarkdownDirtyCloseDialog />
      <MarkdownRecoveryDialog />
      <PurgeConfirmDialog />
      <ExternalLinkDialog />
      <ReaderSettingsDialog />
      <NoteEditorDialog />
    </div>
  );
}
