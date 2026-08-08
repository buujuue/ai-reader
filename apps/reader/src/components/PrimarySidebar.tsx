import { useMemo, useState } from 'react';
import { BookMarked, Search } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { filterMaterialsByQuery } from '../domain/library/libraryFilter';
import { formatFromSourceFileName, formatLabel } from '../domain/library/materialFormat';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { MaterialCover } from './MaterialCover';

/**
 * 书库侧栏:紧凑封面网格 + 标题/作者即时筛选。
 * 迭代规则:读取领域对象(ReadingMaterial),封面按可见范围懒加载;
 * 点击或键盘激活卡片均执行既有 library.openBook Command,不绕过工作区状态所有者。
 */
export function PrimarySidebar() {
  const { commands } = useAppServices();
  const materials = useLibraryStore((state) => state.materials);
  const openMetadataEditor = useShellUiStore((state) => state.openMetadataEditor);
  const [query, setQuery] = useState('');

  const filtered = useMemo(
    () => filterMaterialsByQuery(materials, query),
    [materials, query],
  );

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
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2.5">
        <BookMarked size={16} aria-hidden className="text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-200">书库</h2>
        {materials.length > 0 ? (
          <span className="ml-auto rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {materials.length}
          </span>
        ) : null}
      </div>

      {materials.length > 0 ? (
        <div className="border-b border-zinc-800 px-3 py-2">
          <div className="relative">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按标题或作者筛选…"
              aria-label="筛选书库"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-7 pr-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>
      ) : null}

      {materials.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-zinc-400">尚未导入阅读材料</p>
          <p className="text-xs leading-5 text-zinc-500">
            点击活动栏的导入按钮选择一份 EPUB。外部原文件不会被修改或删除。
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-zinc-400">没有匹配的材料</p>
          <p className="text-xs leading-5 text-zinc-500">换个标题或作者试试。</p>
        </div>
      ) : (
        <ul className="grid flex-1 grid-cols-3 content-start gap-x-2 gap-y-3 overflow-y-auto px-3 py-3">
          {filtered.map((material) => {
            const format = formatFromSourceFileName(material.sourceFileName);
            return (
              <li key={material.id}>
                <div className="group relative">
                  <button
                    type="button"
                    onClick={() => handleOpen(material.id)}
                    title={`打开 ${material.title}`}
                    aria-label={`打开 ${material.title}`}
                    className="flex w-full flex-col gap-1.5 rounded-md text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                  >
                    <MaterialCover materialId={material.id} />
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-medium text-zinc-300 group-hover:text-sky-300">
                        {material.title}
                      </p>
                      <p className="truncate text-[10px] text-zinc-500">
                        {material.author ?? '未知作者'}
                      </p>
                      <p className="mt-0.5 text-[9px] font-medium uppercase tracking-wide text-zinc-500">
                        {formatLabel(format)}
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => openMetadataEditor(material.id)}
                    title={`编辑 ${material.title} 的元数据`}
                    aria-label={`编辑 ${material.title} 的元数据`}
                    className="absolute right-0.5 top-0.5 rounded-md bg-zinc-900/70 p-1 text-zinc-300 opacity-0 transition-opacity hover:text-zinc-100 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <span className="text-[10px]">编辑</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}