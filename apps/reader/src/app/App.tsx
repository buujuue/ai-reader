import { useEffect } from 'react';

import { ActivityBar } from '../components/ActivityBar';
import { EditorArea } from '../components/EditorArea';
import { ExternalLinkDialog } from '../components/ExternalLinkDialog';
import { MetadataEditorDialog } from '../components/MetadataEditorDialog';
import { PrimarySidebar } from '../components/PrimarySidebar';
import { PurgeConfirmDialog } from '../components/PurgeConfirmDialog';
import { ReaderSettingsDialog } from '../components/ReaderSettingsDialog';
import { StatusBar } from '../components/StatusBar';
import { TocSidebar } from '../components/TocSidebar';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { WorkspaceState } from '../domain/workspace/workspaceState';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { useAppServices } from './AppServicesContext';

export function App() {
  const { commands, workspaceRepository, importRepository } = useAppServices();
  const primarySidebarVisible = useWorkspaceStore((state) => state.primarySidebarVisible);
  const tocVisible = useShellUiStore((state) => state.tocVisible);

  useEffect(() => {
    let cancelled = false;
    workspaceRepository
      .loadState()
      .then((state) => {
        if (!cancelled) {
          useWorkspaceStore.getState().hydrate(state);
          void restoreViews(state);
        }
      })
      .catch((error: unknown) => {
        console.error('恢复工作区状态失败', error);
        useShellUiStore.getState().setStatusMessage('恢复工作区状态失败');
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRepository]);

  // 应用关闭/卸载时把全部阅读位置 flush 并关闭渲染器。
  useEffect(() => {
    return () => {
      void import('../workbench/readerCommands')
        .then(({ flushAndCloseAllReaderViews }) => flushAndCloseAllReaderViews())
        .catch(() => undefined);
    };
  }, []);

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
  async function restoreViews(state: WorkspaceState) {
    const materials = await importRepository.listMaterials();
    const views = state.editorGroups.flatMap((group) => group.views);
    for (const view of views) {
      const material = materials.find((material) => material.id === view.materialId) ?? null;
      if (!material) continue;
      await commands
        .execute(COMMAND_IDS.readerRestoreView, view.id, material, view.location)
        .catch((error: unknown) => {
          console.error('恢复阅读视图失败', error);
        });
    }
  }

  useEffect(() => {
    void commands.execute(COMMAND_IDS.libraryRefresh).catch(() => undefined);
  }, [commands]);

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
      <PurgeConfirmDialog />
      <ExternalLinkDialog />
      <ReaderSettingsDialog />
    </div>
  );
}