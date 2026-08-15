import { useShellUiStore } from '../workbench/shellUiStore';
import { useLibraryStore } from '../workbench/libraryStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';

export function StatusBar() {
  const statusMessage = useShellUiStore((state) => state.statusMessage);
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
      <span aria-live="polite">{statusMessage}</span>
    </footer>
  );
}
