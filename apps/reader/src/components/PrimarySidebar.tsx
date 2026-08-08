import { BookMarked, Pencil } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { MaterialCover } from './MaterialCover';

export function PrimarySidebar() {
  const { commands } = useAppServices();
  const materials = useLibraryStore((state) => state.materials);
  const openMetadataEditor = useShellUiStore((state) => state.openMetadataEditor);

  const handleOpen = (materialId: string) => {
    const material = materials.find((item) => item.id === materialId);
    if (!material) return;
    void commands.execute(COMMAND_IDS.libraryOpenBook, material).catch(() => undefined);
  };

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
            <li key={material.id} className="px-2">
              <div className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleOpen(material.id)}
                  title={`打开 ${material.title}`}
                  aria-label={`打开 ${material.title}`}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-zinc-800/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                >
                  <div className="w-7 shrink-0">
                    <MaterialCover materialId={material.id} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-200">{material.title}</p>
                    <p className="truncate text-xs text-zinc-500">
                      {material.author ?? '未知作者'}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => openMetadataEditor(material.id)}
                  title={`编辑 ${material.title} 的元数据`}
                  aria-label={`编辑 ${material.title} 的元数据`}
                  className="rounded-md p-1.5 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Pencil size={14} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}