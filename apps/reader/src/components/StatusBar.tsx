import { useShellUiStore } from '../workbench/shellUiStore';

export function StatusBar() {
  const statusMessage = useShellUiStore((state) => state.statusMessage);

  return (
    <footer
      role="status"
      aria-label="状态栏"
      className="flex h-7 shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-400"
    >
      <span>AI Reader · 本地阅读工作区</span>
      <span aria-live="polite">{statusMessage}</span>
    </footer>
  );
}
