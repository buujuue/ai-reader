import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useLibraryStore } from '../workbench/libraryStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';

export function StatusBar() {
  const { commands } = useAppServices();
  const statusMessage = useShellUiStore((state) => state.statusMessage);
  const annotationUndoTarget = useShellUiStore((state) => state.annotationUndoTarget);
  const activeMaterialId = useWorkspaceStore((state) => {
    const group = state.editorGroups.find((candidate) => candidate.id === state.activeEditorGroupId);
    const view = group?.views.find((candidate) => candidate.id === group.activeViewId);
    return view?.materialId ?? null;
  });
  const activeMaterial = useLibraryStore((state) =>
    state.materials.find((material) => material.id === activeMaterialId),
  );
  const statusLabel = activeMaterial
    ? `AI Reader · ${activeMaterial.title}`
    : 'AI Reader · 本地阅读工作区';

  return (
    <footer
      role="status"
      aria-label="状态栏"
      className="flex h-7 shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-400"
    >
      <span className="min-w-0 truncate" title={statusLabel}>
        {statusLabel}
      </span>
      <span className="flex min-w-0 items-center gap-2" aria-live="polite">
        <span className="truncate">{statusMessage}</span>
        {annotationUndoTarget ? (
          <button
            type="button"
            className="shrink-0 rounded px-2 py-0.5 text-[11px] text-sky-300 hover:bg-zinc-800 hover:text-sky-200 focus:outline-none focus:ring-2 focus:ring-sky-400/70"
            onClick={() => {
              void commands
                .execute(
                  COMMAND_IDS.annotationRestore,
                  annotationUndoTarget.materialId,
                  annotationUndoTarget.annotationId,
                )
                .catch((error: unknown) => console.error('撤销删除批注失败', error));
            }}
          >
            撤销删除
          </button>
        ) : null}
      </span>
    </footer>
  );
}
