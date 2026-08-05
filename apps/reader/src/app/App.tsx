import { useEffect } from 'react';

import { ActivityBar } from '../components/ActivityBar';
import { EditorArea } from '../components/EditorArea';
import { PrimarySidebar } from '../components/PrimarySidebar';
import { StatusBar } from '../components/StatusBar';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { useAppServices } from './AppServicesContext';

export function App() {
  const { commands, workspaceRepository } = useAppServices();
  const primarySidebarVisible = useWorkspaceStore((state) => state.primarySidebarVisible);

  useEffect(() => {
    let cancelled = false;
    workspaceRepository
      .loadState()
      .then((state) => {
        if (!cancelled) {
          useWorkspaceStore.getState().hydrate(state);
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

  useEffect(() => {
    void commands.execute(COMMAND_IDS.libraryRefresh).catch(() => undefined);
  }, [commands]);

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        {primarySidebarVisible ? <PrimarySidebar /> : null}
        <EditorArea />
      </div>
      <StatusBar />
    </div>
  );
}
