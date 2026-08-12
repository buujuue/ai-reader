import { useEffect, useRef } from 'react';

import { ActivityBar } from '../components/ActivityBar';
import { AnnotationSidebar } from '../components/AnnotationSidebar';
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
import { resolveAndroidBackAction } from './androidBackButton';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useSearchStore } from '../workbench/searchStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { getVisibleSidebars, useLayoutPolicy } from '../workbench/layoutPolicy';
import { useAppServices } from './AppServicesContext';

export function App() {
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const layoutPolicy = useLayoutPolicy(workbenchRef);
  const {
    commands,
    workspaceRepository,
    importRepository,
    windowLifecycle,
    androidBackButton,
  } = useAppServices();
  const primarySidebarVisible = useWorkspaceStore((state) => state.primarySidebarVisible);
  const primaryMaterialId = useWorkspaceStore((state) => state.primaryMaterialId);
  const tocVisible = useWorkspaceStore((state) => state.tocVisible);
  const annotationSidebarVisible = useWorkspaceStore((state) => state.annotationSidebarVisible);
  const activeViewId = useWorkspaceStore((state) => {
    const group = state.editorGroups.find((candidate) => candidate.id === state.activeEditorGroupId);
    return group?.activeViewId ?? null;
  });
  const activeViewSourceMode = useWorkspaceStore((state) => {
    const group = state.editorGroups.find((candidate) => candidate.id === state.activeEditorGroupId);
    const view = group?.views.find((candidate) => candidate.id === group.activeViewId);
    return view?.sourceMode ?? false;
  });
  const activeSearchViewId = useSearchStore((state) =>
    activeViewId && state.views[activeViewId]?.active ? activeViewId : null,
  );
  const markdownDirtyCloseOpen = useShellUiStore(
    (state) => state.markdownDirtyCloseViewId !== null,
  );
  const recoveryDialogOpen = useShellUiStore((state) => state.markdownRecoverySnapshots.length > 0);
  const metadataDialogOpen = useShellUiStore((state) => state.metadataEditorMaterialId !== null);
  const purgeDialogOpen = useShellUiStore((state) => state.purgeMaterialId !== null);
  const externalLinkDialogOpen = useShellUiStore((state) => state.externalLinkUrl !== null);
  const typographyDialogOpen = useShellUiStore((state) => state.typographyEditorViewId !== null);
  const noteDialogOpen = useShellUiStore((state) => state.noteEditorTarget !== null);
  const visibleSidebars = getVisibleSidebars(layoutPolicy, {
    primary: primarySidebarVisible,
    toc: tocVisible,
    annotation: annotationSidebarVisible,
  }, tocVisible ? 'toc' : primaryMaterialId ? 'annotation' : 'primary');
  const visibleSidebarKey = visibleSidebars.join(',');

  useEffect(() => {
    let cancelled = false;
    workspaceRepository
      .loadState()
      .then(async (state) => {
        if (!cancelled) {
          useWorkspaceStore.getState().hydrate(state);
          await commands.execute(COMMAND_IDS.libraryRefresh);
          const primaryMaterialId = useWorkspaceStore.getState().primaryMaterialId;
          if (primaryMaterialId) {
            await commands
              .execute(COMMAND_IDS.annotationLoadForMaterial, primaryMaterialId)
              .catch((error: unknown) => {
                console.error('加载主要材料批注失败', error);
              });
          }
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

  // Android 返回键只退出次级状态；脏 Markdown 仍必须经过保存/丢弃确认。
  useEffect(() => {
    if (!androidBackButton) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sidebarCommands = {
      primary: COMMAND_IDS.workbenchTogglePrimarySidebar,
      toc: COMMAND_IDS.workbenchToggleToc,
      annotation: COMMAND_IDS.workbenchToggleAnnotationSidebar,
    } as const;

    void androidBackButton
      .onBackButtonPress((event) => {
        const action = resolveAndroidBackAction({
          compactLayout: layoutPolicy.mode === 'compact',
          visibleSidebars: visibleSidebars as Array<'primary' | 'toc' | 'annotation'>,
          activeViewId,
          activeViewSourceMode,
          activeSearchViewId,
          markdownDirtyCloseOpen,
          recoveryDialogOpen,
          metadataDialogOpen,
          purgeDialogOpen,
          externalLinkDialogOpen,
          typographyDialogOpen,
          noteDialogOpen,
        });

        switch (action.kind) {
          case 'closeSearch':
            void commands.execute(COMMAND_IDS.readerSearchClose, action.viewId).catch(() => undefined);
            break;
          case 'closeSidebar':
            void commands.execute(sidebarCommands[action.sidebar]).catch(() => undefined);
            break;
          case 'dismissMarkdownDirtyClose':
            void commands
              .execute(COMMAND_IDS.shellDismissDialog, 'markdownDirtyClose')
              .catch(() => undefined);
            break;
          case 'dismissMetadataDialog':
            void commands.execute(COMMAND_IDS.shellDismissDialog, 'metadata').catch(() => undefined);
            break;
          case 'dismissPurgeDialog':
            void commands.execute(COMMAND_IDS.shellDismissDialog, 'purge').catch(() => undefined);
            break;
          case 'dismissExternalLinkDialog':
            void commands
              .execute(COMMAND_IDS.shellDismissDialog, 'externalLink')
              .catch(() => undefined);
            break;
          case 'dismissTypographyDialog':
            void commands.execute(COMMAND_IDS.shellDismissDialog, 'typography').catch(() => undefined);
            break;
          case 'dismissNoteDialog':
            void commands.execute(COMMAND_IDS.shellDismissDialog, 'note').catch(() => undefined);
            break;
          case 'exitMarkdownSourceMode':
            void commands
              .execute(COMMAND_IDS.markdownToggleSourceMode, action.viewId)
              .catch(() => undefined);
            break;
          case 'stay':
            break;
          case 'delegateToWebView':
            void commands.execute(COMMAND_IDS.appBack, event.canGoBack).catch(() => undefined);
            break;
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(console.error);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    activeSearchViewId,
    activeViewId,
    activeViewSourceMode,
    commands,
    externalLinkDialogOpen,
    layoutPolicy.mode,
    markdownDirtyCloseOpen,
    metadataDialogOpen,
    noteDialogOpen,
    purgeDialogOpen,
    recoveryDialogOpen,
    androidBackButton,
    typographyDialogOpen,
    visibleSidebarKey,
  ]);

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
    const orderedGroups = [
      ...state.editorGroups.filter((group) => group.id !== state.activeEditorGroupId),
      ...state.editorGroups.filter((group) => group.id === state.activeEditorGroupId),
    ];

    for (const group of orderedGroups) {
      const activeView = group.views.find((view) => view.id === group.activeViewId);
      const fallbackView =
        (activeView && materials.some((material) => material.id === activeView.materialId)
          ? activeView
          : null) ??
        group.views.find((view) => materials.some((material) => material.id === view.materialId));
      if (!fallbackView) continue;

      const material = materials.find((candidate) => candidate.id === fallbackView.materialId);
      if (!material) continue;
      await commands
        .execute(COMMAND_IDS.readerActivateView, fallbackView.id, material)
        .catch((error: unknown) => {
          console.error('恢复阅读视图失败', error);
        });
    }
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <div
        ref={workbenchRef}
        data-layout-mode={layoutPolicy.mode}
        data-sidebar-presentation={layoutPolicy.sidebarPresentation}
        className="relative flex min-h-0 min-w-0 flex-1"
      >
        <ActivityBar />
        {layoutPolicy.sidebarPresentation === 'inline' ? (
          <>
            {visibleSidebars.includes('toc') ? <TocSidebar /> : null}
            {visibleSidebars.includes('primary') ? <PrimarySidebar /> : null}
            <EditorArea layoutPolicy={layoutPolicy} />
            {visibleSidebars.includes('annotation') ? <AnnotationSidebar /> : null}
          </>
        ) : (
          <>
            <EditorArea layoutPolicy={layoutPolicy} />
            <div
              aria-label="紧凑布局侧栏抽屉"
              className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
            >
              {visibleSidebars.includes('toc') ? (
                <div className="pointer-events-auto absolute inset-y-0 left-12 w-60 shadow-2xl shadow-black/50">
                  <TocSidebar />
                </div>
              ) : null}
              {visibleSidebars.includes('primary') ? (
                <div className="pointer-events-auto absolute inset-y-0 left-[15rem] w-64 shadow-2xl shadow-black/50">
                  <PrimarySidebar />
                </div>
              ) : null}
              {visibleSidebars.includes('annotation') ? (
                <div className="pointer-events-auto absolute inset-y-0 right-0 w-72 shadow-2xl shadow-black/50">
                  <AnnotationSidebar />
                </div>
              ) : null}
            </div>
          </>
        )}
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
