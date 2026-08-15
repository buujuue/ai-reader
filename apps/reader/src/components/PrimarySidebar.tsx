import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, BookMarked, BookOpenCheck, FilePlus2, RotateCcw, Search, Trash2 } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { filterMaterialsByQuery } from '../domain/library/libraryFilter';
import { formatFromSourceFileName, formatLabel } from '../domain/library/materialFormat';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { MaterialCover } from './MaterialCover';

/**
 * 书库侧栏:紧凑封面网格 + 标题/作者即时筛选 + 回收站区块。
 * 迭代规则:读取领域对象(ReadingMaterial),封面按可见范围懒加载;
 * 点击或键盘激活卡片均执行既有命令,不绕过工作区状态所有者。
 */
export function PrimarySidebar() {
  const { commands } = useAppServices();
  const materials = useLibraryStore((state) => state.materials);
  const trashedMaterials = useLibraryStore((state) => state.trashedMaterials);
  const openMetadataEditor = useShellUiStore((state) => state.openMetadataEditor);
  const openPurgeConfirm = useShellUiStore((state) => state.openPurgeConfirm);
  const primaryMaterialId = useWorkspaceStore((state) => state.primaryMaterialId);
  const importing = useLibraryStore((state) => state.importing);
  const libraryFilterFocusToken = useShellUiStore((state) => state.libraryFilterFocusToken);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [showTrash, setShowTrash] = useState(false);

  const filtered = useMemo(
    () => filterMaterialsByQuery(materials, query),
    [materials, query],
  );

  useEffect(() => {
    if (libraryFilterFocusToken > 0) filterRef.current?.focus();
  }, [libraryFilterFocusToken]);

  const handleOpen = (materialId: string) => {
    const material = materials.find((item) => item.id === materialId);
    if (!material) return;
    void commands.execute(COMMAND_IDS.libraryOpenBook, material).catch(() => undefined);
  };

  const handleTrash = (materialId: string) => {
    void commands.execute(COMMAND_IDS.libraryTrash, materialId).catch(() => undefined);
  };

  const handleRestore = (materialId: string) => {
    void commands.execute(COMMAND_IDS.libraryRestoreFromTrash, materialId).catch(() => undefined);
  };

  const handlePurge = (materialId: string) => {
    openPurgeConfirm(materialId);
  };

  const handleSetPrimary = (materialId: string) => {
    void commands
      .execute(COMMAND_IDS.workbenchSetPrimaryMaterial, materialId)
      .catch(() => undefined);
  };

  const handleImport = () => {
    void commands.execute(COMMAND_IDS.libraryImport).catch(() => undefined);
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
        <button
          type="button"
          aria-label="导入 EPUB"
          title="导入阅读材料(EPUB、PDF、Markdown)"
          onClick={handleImport}
          disabled={importing}
          className="ml-auto rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--prototype-focus)] disabled:opacity-50"
        >
          <FilePlus2 size={15} aria-hidden />
        </button>
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
              ref={filterRef}
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
            点击右上角导入按钮选择 EPUB、PDF 或 Markdown。外部原文件不会被修改或删除。
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
                  <div className="absolute right-0.5 top-0.5 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => handleTrash(material.id)}
                      title={`移入回收站 ${material.title}`}
                      aria-label={`移入回收站 ${material.title}`}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded-md bg-zinc-900/70 p-1 text-zinc-300 hover:text-red-300 focus-visible:opacity-100"
                    >
                      <Trash2 size={12} aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => openMetadataEditor(material.id)}
                      title={`编辑 ${material.title} 的元数据`}
                      aria-label={`编辑 ${material.title} 的元数据`}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded-md bg-zinc-900/70 p-1 text-zinc-300 hover:text-zinc-100"
                    >
                      <span className="text-[10px]">编辑</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetPrimary(material.id)}
                      title={
                        primaryMaterialId === material.id
                          ? `当前主要材料 ${material.title}`
                          : `设为主要材料 ${material.title}`
                      }
                      aria-label={
                        primaryMaterialId === material.id
                          ? `当前主要材料 ${material.title}`
                          : `设为主要材料 ${material.title}`
                      }
                      aria-pressed={primaryMaterialId === material.id}
                      className={`flex min-h-11 min-w-11 items-center justify-center rounded-md bg-zinc-900/70 p-1 transition-colors hover:text-sky-300 focus-visible:opacity-100 ${
                        primaryMaterialId === material.id ? 'text-sky-300' : 'text-zinc-300'
                      }`}
                    >
                      <BookOpenCheck size={12} aria-hidden />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {trashedMaterials.length > 0 ? (
        <div className="border-t border-zinc-800">
          <button
            type="button"
            onClick={() => setShowTrash((visible) => !visible)}
            aria-expanded={showTrash}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
          >
            <Archive size={14} aria-hidden />
            回收站
            <span className="ml-auto rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {trashedMaterials.length}
            </span>
          </button>
          {showTrash ? (
            <ul className="max-h-56 overflow-y-auto border-t border-zinc-800/60 px-2 py-1">
              {trashedMaterials.map((material) => (
                <li
                  key={material.id}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-zinc-800/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] text-zinc-400">{material.title}</p>
                    <p className="truncate text-[10px] text-zinc-600">
                      {material.author ?? '未知作者'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRestore(material.id)}
                    title={`恢复 ${material.title}`}
                    aria-label={`恢复 ${material.title}`}
                    className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
                  >
                    <RotateCcw size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePurge(material.id)}
                    title={`永久删除 ${material.title}`}
                    aria-label={`永久删除 ${material.title}`}
                    className="rounded p-1 text-zinc-500 transition-colors hover:bg-red-900/40 hover:text-red-300"
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
