import { LibraryBig } from 'lucide-react';

export function PrimarySidebar() {
  return (
    <aside
      aria-label="书库侧栏"
      className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40"
    >
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <LibraryBig size={18} aria-hidden className="text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-200">书库</h2>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-zinc-400">尚未导入阅读材料</p>
        <p className="text-xs leading-5 text-zinc-500">
          EPUB、PDF 与 Markdown 的导入将在后续切片中接入。
        </p>
      </div>
    </aside>
  );
}
