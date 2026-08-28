import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  BookOpenCheck,
  Check,
  ChevronRight,
  FilePlus2,
  FileWarning,
  Folder,
  FolderOpen,
  FolderPlus,
  LibraryBig,
  Link2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import {
  getLibraryFolderDepth,
  MAX_LIBRARY_FOLDER_DEPTH,
  sortLibraryFolders,
  type LibraryFolder,
} from '../domain/library/libraryFolder';
import { filterMaterialsByQuery } from '../domain/library/libraryFilter';
import { formatFromSourceFileName, formatLabel } from '../domain/library/materialFormat';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { MaterialCover } from './MaterialCover';
import { SidebarPanelHeader } from './SidebarPanelHeader';

type FolderEditorState =
  | { kind: 'create'; parentId: string | null; value: string; error: string | null }
  | { kind: 'rename'; folderId: string; value: string; error: string | null };

function folderErrorMessage(error: unknown, fallback = '文件夹操作失败,请重试'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return fallback;
}

/**
 * 书库侧栏:持久化文件夹树、未归类封面网格、标题/作者即时筛选 + 回收站区块。
 * 迭代规则:读取领域对象(ReadingMaterial),封面按可见范围懒加载;
 * 点击或键盘激活卡片均执行既有命令,不绕过工作区状态所有者。
 */
export function PrimarySidebar() {
  const { commands } = useAppServices();
  const materials = useLibraryStore((state) => state.materials);
  const folders = useLibraryStore((state) => state.folders);
  const trashedMaterials = useLibraryStore((state) => state.trashedMaterials);
  const openMetadataEditor = useShellUiStore((state) => state.openMetadataEditor);
  const openPurgeConfirm = useShellUiStore((state) => state.openPurgeConfirm);
  const primaryMaterialId = useWorkspaceStore((state) => state.primaryMaterialId);
  const expandedFolderIds = useWorkspaceStore((state) => state.expandedLibraryFolderIds);
  const importing = useLibraryStore((state) => state.importing);
  const libraryFilterFocusToken = useShellUiStore((state) => state.libraryFilterFocusToken);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [showTrash, setShowTrash] = useState(false);
  const [focusedMaterialId, setFocusedMaterialId] = useState<string | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [folderEditor, setFolderEditor] = useState<FolderEditorState | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(
    () => filterMaterialsByQuery(materials, query),
    [materials, query],
  );

  const folderChildren = useMemo(() => {
    const children = new Map<string, LibraryFolder[]>();
    for (const folder of sortLibraryFolders(folders)) {
      if (folder.parentId === null) continue;
      const siblings = children.get(folder.parentId) ?? [];
      siblings.push(folder);
      children.set(folder.parentId, siblings);
    }
    return children;
  }, [folders]);

  const rootFolders = useMemo(
    () => sortLibraryFolders(folders.filter((folder) => folder.parentId === null)),
    [folders],
  );

  const visibleFolderIds = useMemo(() => {
    const queryKey = query.trim().toLowerCase();
    if (!queryKey) return new Set(folders.map((folder) => folder.id));
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const visible = new Set<string>();
    for (const folder of folders) {
      if (!folder.name.toLowerCase().includes(queryKey)) continue;
      let current: LibraryFolder | undefined = folder;
      while (current) {
        if (visible.has(current.id)) break;
        visible.add(current.id);
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
    }
    return visible;
  }, [folders, query]);

  useEffect(() => {
    if (libraryFilterFocusToken > 0) filterRef.current?.focus();
  }, [libraryFilterFocusToken]);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) setMoreMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    const firstItem = moreMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    firstItem?.focus();
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [moreMenuOpen]);

  const focusedMaterial = materials.find((material) => material.id === focusedMaterialId) ?? null;

  useEffect(() => {
    if (focusedMaterialId && !focusedMaterial) {
      setFocusedMaterialId(null);
      setMoreMenuOpen(false);
    }
  }, [focusedMaterial, focusedMaterialId]);

  useEffect(() => {
    if (folderEditor?.kind === 'rename' && !folders.some((folder) => folder.id === folderEditor.folderId)) {
      setFolderEditor(null);
    }
  }, [folderEditor, folders]);

  useEffect(() => {
    if (!folderEditor) return;
    folderInputRef.current?.focus();
    folderInputRef.current?.select();
  }, [
    folderEditor?.kind,
    folderEditor?.kind === 'rename' ? folderEditor.folderId : null,
    folderEditor?.kind === 'create' ? folderEditor.parentId : null,
  ]);

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

  const handleRelink = (materialId: string) => {
    void commands.execute(COMMAND_IDS.libraryRelink, materialId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '请重新选择相同内容的文件';
      useShellUiStore.getState().setStatusMessage(`重新关联失败:${message}`);
    });
  };

  const focusMaterial = (materialId: string) => {
    setFocusedMaterialId(materialId);
  };

  const openMoreMenuForMaterial = (materialId: string) => {
    focusMaterial(materialId);
    setMoreMenuOpen(true);
  };

  const closeMoreMenu = () => setMoreMenuOpen(false);

  const startCreateFolder = (parentId: string | null) => {
    if (parentId !== null) {
      const parent = folders.find((folder) => folder.id === parentId);
      if (!parent || getLibraryFolderDepth(parent.id, folders) >= MAX_LIBRARY_FOLDER_DEPTH) return;
      void commands
        .execute(COMMAND_IDS.workbenchSetLibraryFolderExpanded, parentId, true)
        .catch(() => undefined);
    }
    setFolderEditor({ kind: 'create', parentId, value: '', error: null });
  };

  const startRenameFolder = (folder: LibraryFolder) => {
    setFolderEditor({ kind: 'rename', folderId: folder.id, value: folder.name, error: null });
  };

  const cancelFolderEdit = () => setFolderEditor(null);

  const saveFolderEdit = async () => {
    if (!folderEditor) return;
    try {
      if (folderEditor.kind === 'create') {
        await commands.execute(COMMAND_IDS.libraryCreateFolder, folderEditor.value, folderEditor.parentId);
      } else {
        await commands.execute(COMMAND_IDS.libraryRenameFolder, folderEditor.folderId, folderEditor.value);
      }
      setFolderEditor(null);
    } catch (error: unknown) {
      const message = folderErrorMessage(error);
      setFolderEditor((current) => current ? { ...current, error: message } : current);
      useShellUiStore.getState().setStatusMessage(message);
      folderInputRef.current?.focus();
    }
  };

  const toggleFolder = (folderId: string, expanded: boolean) => {
    void commands
      .execute(COMMAND_IDS.workbenchSetLibraryFolderExpanded, folderId, expanded)
      .catch((error: unknown) => {
        const message = folderErrorMessage(error, '保存文件夹展开状态失败');
        useShellUiStore.getState().setStatusMessage(message);
      });
  };

  const renderFolderEditor = (level: number): ReactNode => {
    if (!folderEditor) return null;
    const label = folderEditor.kind === 'create'
      ? folderEditor.parentId === null ? '新建文件夹名称' : '新建子文件夹名称'
      : '重命名文件夹';
    return (
      <li className="library-folder-editor" role="treeitem" aria-level={level}>
        <div className="library-folder-editor-row">
          <input
            ref={folderInputRef}
            type="text"
            value={folderEditor.value}
            aria-label={label}
            aria-invalid={folderEditor.error ? 'true' : 'false'}
            onChange={(event) => setFolderEditor((current) => current ? {
              ...current,
              value: event.target.value,
              error: null,
            } : current)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelFolderEdit();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                void saveFolderEdit();
              }
            }}
          />
          <button type="button" aria-label="保存文件夹" title="按 Enter 保存" onClick={() => void saveFolderEdit()}>
            <Check size={14} aria-hidden />
          </button>
          <button type="button" aria-label="取消文件夹命名" title="按 Escape 取消" onClick={cancelFolderEdit}>
            <X size={14} aria-hidden />
          </button>
        </div>
        {folderEditor.error ? <p className="library-folder-error" role="alert">{folderEditor.error}</p> : null}
      </li>
    );
  };

  const renderFolderNode = (folder: LibraryFolder, level: number): ReactNode => {
    if (!visibleFolderIds.has(folder.id)) return null;
    const children = (folderChildren.get(folder.id) ?? []).filter((child) => visibleFolderIds.has(child.id));
    const queryIsActive = query.trim().length > 0;
    const editingChild = folderEditor?.kind === 'create' && folderEditor.parentId === folder.id;
    const expanded = expandedFolderIds.includes(folder.id) ||
      editingChild ||
      (queryIsActive && children.some((child) => visibleFolderIds.has(child.id)));
    const canCreateChild = getLibraryFolderDepth(folder.id, folders) < MAX_LIBRARY_FOLDER_DEPTH;
    return (
      <li key={folder.id} className="library-folder-tree-item" role="treeitem" aria-level={level} aria-expanded={expanded}>
        <div className="library-folder-row">
          <button
            type="button"
            className="library-folder-toggle"
            aria-label={`${expanded ? '收起' : '展开'}文件夹 ${folder.name}`}
            aria-expanded={expanded}
            onClick={() => toggleFolder(folder.id, !expanded)}
          >
            <ChevronRight className={expanded ? 'library-folder-chevron expanded' : 'library-folder-chevron'} size={14} aria-hidden />
            {expanded ? <FolderOpen size={16} aria-hidden /> : <Folder size={16} aria-hidden />}
            <span title={folder.name}>{folder.name}</span>
          </button>
          <div className="library-folder-actions">
            <button
              type="button"
              aria-label={canCreateChild ? `在“${folder.name}”中新建子文件夹` : `新建子文件夹（${folder.name}）已达到最多五层`}
              title={canCreateChild ? '新建子文件夹' : '已达到最多五层'}
              disabled={!canCreateChild}
              onClick={() => startCreateFolder(folder.id)}
            >
              <FolderPlus size={14} aria-hidden />
            </button>
            <button type="button" aria-label={`重命名 ${folder.name}`} title="重命名文件夹" onClick={() => startRenameFolder(folder)}>
              <Pencil size={13} aria-hidden />
            </button>
          </div>
        </div>
        {folderEditor?.kind === 'rename' && folderEditor.folderId === folder.id
          ? renderFolderEditor(level)
          : null}
        {expanded ? (
          <ul className="library-folder-group" role="group">
            {children.map((child) => renderFolderNode(child, level + 1))}
            {editingChild ? renderFolderEditor(level + 1) : null}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <aside
      aria-label="书库侧栏"
      className="app-sidebar-panel"
    >
      <SidebarPanelHeader
        icon={LibraryBig}
        title="书库"
        action={
          <>
            <div ref={moreMenuRef} className="relative">
              <button
                type="button"
                aria-label="书库更多操作"
                title={
                  focusedMaterial
                    ? `书库更多操作（${focusedMaterial.title}）`
                    : '先悬浮或键盘聚焦一张书卡'
                }
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                onClick={() => {
                  if (focusedMaterial) setMoreMenuOpen((open) => !open);
                }}
                disabled={!focusedMaterial}
                className="sidebar-panel-header-action"
              >
                <MoreHorizontal size={16} aria-hidden />
              </button>
              {moreMenuOpen && focusedMaterial ? (
                <div role="menu" aria-label="书库更多操作菜单" className="app-menu library-more-menu">
                  <div className="library-more-menu-context" role="presentation">
                    <span className="library-more-menu-eyebrow">当前书卡</span>
                    <strong title={focusedMaterial.title}>{focusedMaterial.title}</strong>
                  </div>
                  {focusedMaterial.managedFileAvailable === false ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        handleRelink(focusedMaterial.id);
                        closeMoreMenu();
                      }}
                    >
                      <Link2 size={14} aria-hidden />
                      <span>重新关联正文</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      openMetadataEditor(focusedMaterial.id);
                      closeMoreMenu();
                    }}
                  >
                    <Pencil size={14} aria-hidden />
                    <span>编辑元数据</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      handleSetPrimary(focusedMaterial.id);
                      closeMoreMenu();
                    }}
                  >
                    <BookOpenCheck size={14} aria-hidden />
                    <span>
                      {primaryMaterialId === focusedMaterial.id ? '当前主要材料' : '设为主要材料'}
                    </span>
                  </button>
                  <div role="separator" className="app-menu-separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="library-menu-danger"
                    onClick={() => {
                      handleTrash(focusedMaterial.id);
                      closeMoreMenu();
                    }}
                  >
                    <Trash2 size={14} aria-hidden />
                    <span>移入回收站</span>
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="导入 EPUB"
              title="导入阅读材料(EPUB、PDF、Markdown)"
              onClick={handleImport}
              disabled={importing}
              className="sidebar-panel-header-action"
            >
              <FilePlus2 size={16} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="新建文件夹"
              title="新建顶层文件夹"
              onClick={() => startCreateFolder(null)}
              className="sidebar-panel-header-action"
            >
              <FolderPlus size={16} aria-hidden />
            </button>
          </>
        }
      />

      {materials.length > 0 || folders.length > 0 ? (
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
              placeholder="按文件夹、标题或作者筛选…"
              aria-label="筛选书库"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-7 pr-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>
      ) : null}

      <div className="library-tree-scroll">
        <ul className="library-tree" role="tree" aria-label="书库文件夹树">
          {folderEditor?.kind === 'create' && folderEditor.parentId === null ? renderFolderEditor(1) : null}
          {rootFolders.map((folder) => renderFolderNode(folder, 1))}
          <li className="library-unfiled-tree-item" role="treeitem" aria-level={1} aria-expanded="true">
            <div className="library-unfiled-row">
              <FolderOpen size={16} aria-hidden />
              <span>未归类</span>
            </div>
            <ul className="library-material-group" role="group">
              {materials.length === 0 ? (
                <li className="library-tree-empty">
                  <p>尚未导入阅读材料</p>
                  <span>点击右上角导入按钮选择 EPUB、PDF 或 Markdown。外部原文件不会被修改或删除。</span>
                </li>
              ) : filtered.length === 0 ? (
                <li className="library-tree-empty">
                  <p>没有匹配的材料</p>
                  <span>换个标题或作者试试。</span>
                </li>
              ) : filtered.map((material) => {
            const format = formatFromSourceFileName(material.sourceFileName);
            return (
              <li key={material.id} role="treeitem" aria-level={2}>
                <div
                  className="group relative library-material-tree-item"
                  onPointerEnter={() => {
                    focusMaterial(material.id);
                    setMoreMenuOpen(false);
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      focusMaterial(material.id);
                      handleOpen(material.id);
                    }}
                    onFocus={() => focusMaterial(material.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        openMoreMenuForMaterial(material.id);
                      }
                    }}
                    title={
                      material.managedFileAvailable === false
                        ? `${material.title}（正文不可用，可重新导入相同文件以恢复）`
                        : `打开 ${material.title}`
                    }
                    aria-label={`打开 ${material.title}`}
                    className="flex w-full flex-col gap-1.5 rounded-md text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
                  >
                    <MaterialCover materialId={material.id} title={material.title} />
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-medium text-zinc-300 group-hover:text-sky-300">
                        {material.title}
                      </p>
                      <p className="truncate text-[10px] text-zinc-500">
                        {material.author ?? '未知作者'}
                      </p>
                      <p
                        className={`mt-0.5 flex items-center gap-1 text-[10px] font-medium tracking-wide ${
                          material.managedFileAvailable === false
                            ? 'text-amber-300'
                            : 'uppercase text-zinc-500'
                        }`}
                      >
                        {material.managedFileAvailable === false ? (
                          <>
                            <FileWarning size={10} aria-hidden />
                            正文不可用
                          </>
                        ) : (
                          formatLabel(format)
                        )}
                      </p>
                    </div>
                  </button>
                </div>
              </li>
            );
          })}
            </ul>
          </li>
        </ul>
      </div>

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
