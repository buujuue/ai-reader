import { BookMarked } from 'lucide-react';

import { useLibraryStore } from '../workbench/libraryStore';

export function PrimarySidebar() {
  const materials = useLibraryStore((state) => state.materials);

  return (
    <aside
      aria-label="书库侧栏"
      className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40"
    >
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <BookMarked size={18} aria-hidden className="text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-200">书库</h2>
      </div>
      {materials.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-zinc-400">尚未导入阅读材料</p>
          <p className="text-xs leading-5 text-zinc-500">
            点击活动栏的导入按钮选择一份 EPUB。外部原文件不会被修改或删除。
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto py-2">
          {materials.map((material) => (
            <li
              key={material.id}
              className="flex items-center gap-3 px-4 py-2"
            >
              <div className="flex h-9 w-7 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-zinc-700 bg-zinc-800 text-xs text-zinc-400">
                <BookMarked size={14} aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm text-zinc-200">{material.title}</p>
                <p className="truncate text-xs text-zinc-500">
                  {material.author ?? '未知作者'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
