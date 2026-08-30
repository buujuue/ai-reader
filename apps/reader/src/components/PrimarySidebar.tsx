import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
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
import {
  buildLibraryTreeSearch,
  type LibraryTreeSearchResult,
} from '../domain/library/libraryFilter';
import type { ReadingMaterial } from '../domain/library/material';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import {
  readLibraryMaterialDragMaterialId,
  writeLibraryMaterialDragPayload,
} from './libraryDragDrop';
import { SidebarPanelHeader } from './SidebarPanelHeader';

type FolderEditorState =
  | { kind: 'create'; parentId: string | null; value: string; error: string | null }
  | { kind: 'rename'; folderId: string; value: string; error: string | null };

interface MoveFolderOption {
  id: string;
  label: string;
  depth: number;
}

type LibraryTreeItemKind = 'folder' | 'material';
type LibraryDropState = 'valid' | 'same' | 'invalid';
type LibraryDropDestination =
  | { kind: 'folder'; folderId: string }
  | { kind: 'unfiled' }
  | { kind: 'invalid' };

interface LibraryTreeItem {
  key: string;
  kind: LibraryTreeItemKind;
  folderId?: string;
  materialId?: string;
  parentKey: string | null;
  expandable: boolean;
  expanded: boolean;
}

interface PointerMaterialDragState {
  pointerId: number;
  materialId: string;
  source: HTMLLIElement;
  startX: number;
  startY: number;
  active: boolean;
}

function folderErrorMessage(error: unknown, fallback = '文件夹操作失败,请重试'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return fallback;
}

function sortMaterialsByTitle(materials: readonly ReadingMaterial[]): ReadingMaterial[] {
  return [...materials].sort(
    (left, right) =>
      left.title.localeCompare(right.title, 'zh-CN') || left.id.localeCompare(right.id),
  );
}

function libraryDropStateLabel(state: LibraryDropState): string {
  if (state === 'valid') return '放置到这里';
  if (state === 'same') return '已在此处';
  return '仅支持单本材料';
}

function canDragLibraryMaterials(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  // 混合设备可能把主指针报告为 coarse,但仍连接了鼠标或触控板;
  // 只要存在精确指针就保留拖放快捷方式,纯触控设备仍交给“移动到…”菜单。
  return (
    window.matchMedia('(any-pointer: fine)').matches ||
    !window.matchMedia('(pointer: coarse)').matches
  );
}

function flattenMoveFolderOptions(folders: readonly LibraryFolder[]): MoveFolderOption[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const byParent = new Map<string | null, LibraryFolder[]>();
  for (const folder of folders) {
    const parentId = folder.parentId !== null && byId.has(folder.parentId)
      ? folder.parentId
      : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(folder);
    byParent.set(parentId, siblings);
  }

  const options: MoveFolderOption[] = [];
  const visited = new Set<string>();
  const visit = (
    folder: LibraryFolder,
    path: string[],
    depth: number,
    ancestors: Set<string>,
  ) => {
    if (ancestors.has(folder.id) || visited.has(folder.id)) return;
    visited.add(folder.id);
    const nextAncestors = new Set(ancestors).add(folder.id);
    const nextPath = [...path, folder.name];
    options.push({ id: folder.id, label: nextPath.join(' / '), depth });
    for (const child of sortLibraryFolders(byParent.get(folder.id) ?? [])) {
      visit(child, nextPath, depth + 1, nextAncestors);
    }
  };

  for (const root of sortLibraryFolders(byParent.get(null) ?? [])) {
    visit(root, [], 1, new Set());
  }
  // 损坏的循环数据不应让移动菜单丢失其它可用目标。
  for (const folder of sortLibraryFolders(folders)) {
    visit(folder, [], 1, new Set());
  }
  return options;
}

/**
 * 书库侧栏:持久化文件夹树、底部未归类区块、标题/作者即时筛选 + 回收站区块。
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
  const openFolderDeleteConfirm = useShellUiStore((state) => state.openFolderDeleteConfirm);
  const primaryMaterialId = useWorkspaceStore((state) => state.primaryMaterialId);
  const expandedFolderIds = useWorkspaceStore((state) => state.expandedLibraryFolderIds);
  const storedUnfiledExpanded = useWorkspaceStore((state) => state.unfiledMaterialsExpanded);
  const importing = useLibraryStore((state) => state.importing);
  const libraryFilterFocusToken = useShellUiStore((state) => state.libraryFilterFocusToken);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [showTrash, setShowTrash] = useState(false);
  const [focusedMaterialId, setFocusedMaterialId] = useState<string | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [searchExpansionOverrides, setSearchExpansionOverrides] = useState<Record<string, boolean>>({});
  const [unfiledSearchOverride, setUnfiledSearchOverride] = useState<boolean | null>(null);
  const [focusedTreeItemKey, setFocusedTreeItemKey] = useState<string | null>(null);
  const [folderEditor, setFolderEditor] = useState<FolderEditorState | null>(null);
  const [draggedMaterialId, setDraggedMaterialId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    key: string;
    state: LibraryDropState;
  } | null>(null);
  const [pointerMaterialDragActive, setPointerMaterialDragActive] = useState(false);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const treeItemRefs = useRef(new Map<string, HTMLLIElement>());
  const draggedMaterialIdRef = useRef<string | null>(null);
  const pointerMaterialDragRef = useRef<PointerMaterialDragState | null>(null);
  const suppressMaterialClickRef = useRef(false);
  const materialDraggingEnabled = canDragLibraryMaterials();

  const searchResult: LibraryTreeSearchResult = useMemo(
    () => buildLibraryTreeSearch(folders, materials, query),
    [folders, materials, query],
  );
  const queryKey = searchResult.query;
  const visibleMaterialIds = searchResult.visibleMaterialIds;
  const visibleFolderIds = searchResult.visibleFolderIds;

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

  const moveFolderOptions = useMemo(() => flattenMoveFolderOptions(folders), [folders]);
  const unfiledMaterials = useMemo(
    () =>
      sortMaterialsByTitle(
        materials.filter(
          (material) => material.folderId === null && visibleMaterialIds.has(material.id),
        ),
      ),
    [materials, visibleMaterialIds],
  );
  const unfiledExpanded = queryKey
    ? (unfiledSearchOverride ?? (storedUnfiledExpanded || unfiledMaterials.length > 0))
    : storedUnfiledExpanded;

  const isFolderExpanded = (folderId: string): boolean => {
    const override = queryKey ? searchExpansionOverrides[folderId] : undefined;
    if (override !== undefined) return override;
    return expandedFolderIds.includes(folderId) || searchResult.autoExpandedFolderIds.has(folderId);
  };

  useEffect(() => {
    if (!queryKey) {
      setSearchExpansionOverrides({});
      setUnfiledSearchOverride(null);
    }
  }, [queryKey]);

  const visibleTreeItems = useMemo(() => {
    const items: LibraryTreeItem[] = [];
    const addFolder = (folder: LibraryFolder, parentKey: string | null) => {
      if (!searchResult.visibleFolderIds.has(folder.id)) return;
      const key = `folder:${folder.id}`;
      const children = (folderChildren.get(folder.id) ?? []).filter((child) =>
        searchResult.visibleFolderIds.has(child.id),
      );
      const folderMaterials = materials.filter(
        (material) => material.folderId === folder.id && visibleMaterialIds.has(material.id),
      );
      const expanded = isFolderExpanded(folder.id);
      items.push({
        key,
        kind: 'folder',
        folderId: folder.id,
        parentKey,
        expandable: children.length > 0 || folderMaterials.length > 0,
        expanded,
      });
      if (!expanded) return;
      for (const child of children) addFolder(child, key);
      for (const material of sortMaterialsByTitle(folderMaterials)) {
        items.push({
          key: `material:${material.id}`,
          kind: 'material',
          materialId: material.id,
          parentKey: key,
          expandable: false,
          expanded: false,
        });
      }
    };
    for (const folder of rootFolders) addFolder(folder, null);
    return items;
  }, [
    expandedFolderIds,
    folderChildren,
    folders,
    materials,
    queryKey,
    rootFolders,
    searchExpansionOverrides,
    searchResult,
    unfiledMaterials,
    visibleMaterialIds,
  ]);

  const activeTreeItemKey = visibleTreeItems.some((item) => item.key === focusedTreeItemKey)
    ? focusedTreeItemKey
    : visibleTreeItems[0]?.key ?? null;
  const unfiledDropState = dropTarget?.key === 'unfiled' ? dropTarget.state : undefined;

  const focusTreeItem = (key: string) => {
    if (!visibleTreeItems.some((item) => item.key === key)) return;
    setFocusedTreeItemKey(key);
    treeItemRefs.current.get(key)?.focus();
  };

  const toggleUnfiled = (expanded: boolean) => {
    if (queryKey) {
      setUnfiledSearchOverride(expanded);
      return;
    }
    void commands
      .execute(COMMAND_IDS.workbenchSetUnfiledMaterialsExpanded, expanded)
      .catch((error: unknown) => {
        useShellUiStore.getState().setStatusMessage(
          `保存未归类展开状态失败:${folderErrorMessage(error, '请重试')}`,
        );
      });
  };

  const handleTreeItemKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>, item: LibraryTreeItem) => {
    const index = visibleTreeItems.findIndex((candidate) => candidate.key === item.key);
    if (index < 0) return;
    const activationKey = event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
    if (activationKey) {
      event.preventDefault();
      if (item.kind === 'material' && item.materialId) handleOpen(item.materialId);
      else if (item.kind === 'folder' && item.folderId) toggleFolder(item.folderId, !item.expanded);
      return;
    }
    if (event.key === 'Escape') {
      if (queryKey) {
        event.preventDefault();
        setQuery('');
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1;
      const next = visibleTreeItems[nextIndex];
      if (next) focusTreeItem(next.key);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusTreeItem(event.key === 'Home' ? visibleTreeItems[0]!.key : visibleTreeItems.at(-1)!.key);
      return;
    }
    if (event.key === 'ArrowRight' && item.expandable) {
      event.preventDefault();
      if (!item.expanded) {
        if (item.kind === 'folder' && item.folderId) toggleFolder(item.folderId, true);
      } else {
        const child = visibleTreeItems[index + 1];
        if (child?.parentKey === item.key) focusTreeItem(child.key);
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (item.expandable && item.expanded) {
        if (item.kind === 'folder' && item.folderId) toggleFolder(item.folderId, false);
      } else if (item.parentKey) {
        focusTreeItem(item.parentKey);
      }
    }
  };

  useEffect(() => {
    if (libraryFilterFocusToken > 0) filterRef.current?.focus();
  }, [libraryFilterFocusToken]);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) {
        setMoreMenuOpen(false);
        setMoveMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreMenuOpen(false);
        setMoveMenuOpen(false);
      }
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
      setMoveMenuOpen(false);
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
    setMoveMenuOpen(false);
    setMoreMenuOpen(true);
  };

  const closeMoreMenu = () => {
    setMoreMenuOpen(false);
    setMoveMenuOpen(false);
  };

  const handleMoveMaterial = async (materialId: string, folderId: string | null) => {
    try {
      await commands.execute(COMMAND_IDS.libraryMoveMaterial, materialId, folderId);
      if (folderId !== null) {
        if (queryKey) {
          setSearchExpansionOverrides((current) => ({ ...current, [folderId]: true }));
        } else {
          void commands
            .execute(COMMAND_IDS.workbenchSetLibraryFolderExpanded, folderId, true)
            .catch((error: unknown) => {
              useShellUiStore.getState().setStatusMessage(
                `保存文件夹展开状态失败:${folderErrorMessage(error, '请重试')}`,
              );
            });
        }
      }
      closeMoreMenu();
    } catch (error: unknown) {
      useShellUiStore.getState().setStatusMessage(
        `移动材料失败:${folderErrorMessage(error, '请重试')}`,
      );
    }
  };

  const clearMaterialDrag = () => {
    draggedMaterialIdRef.current = null;
    setDraggedMaterialId(null);
    setDropTarget(null);
  };

  const getDraggedMaterialId = (dataTransfer: DataTransfer | null | undefined): string | null =>
    draggedMaterialIdRef.current ?? readLibraryMaterialDragMaterialId(dataTransfer);

  const resolveDropState = (
    materialId: string | null,
    destination: LibraryDropDestination,
  ): LibraryDropState => {
    if (destination.kind === 'invalid') return 'invalid';
    const folderId = destination.kind === 'folder' ? destination.folderId : null;
    const material = materialId ? materials.find((item) => item.id === materialId) : undefined;
    if (!material || (folderId !== null && !folders.some((folder) => folder.id === folderId))) {
      return 'invalid';
    }
    return material.folderId === folderId ? 'same' : 'valid';
  };

  const getPointerDropTarget = (
    clientX: number,
    clientY: number,
  ): { key: string; destination: LibraryDropDestination } | null => {
    const element = document.elementFromPoint(clientX, clientY);
    if (!element) return null;
    const folderElement = element.closest<HTMLElement>('[data-library-drop-target="folder"]');
    const folderId = folderElement?.dataset.libraryFolderId;
    if (folderElement && folderId) {
      return {
        key: `folder:${folderId}`,
        destination: { kind: 'folder', folderId },
      };
    }
    const unfiledElement = element.closest<HTMLElement>('[data-library-drop-target="unfiled"]');
    if (unfiledElement) {
      return { key: 'unfiled', destination: { kind: 'unfiled' } };
    }
    return null;
  };

  const updateDropTarget = (
    event: ReactDragEvent<HTMLElement>,
    key: string,
    destination: LibraryDropDestination,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const state = resolveDropState(getDraggedMaterialId(event.dataTransfer), destination);
    setDropTarget({ key, state });
    event.dataTransfer.dropEffect = state === 'valid' ? 'move' : 'none';
  };

  const handleDropLeave = (event: ReactDragEvent<HTMLElement>, key: string) => {
    event.stopPropagation();
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget &&
      typeof relatedTarget === 'object' &&
      'nodeType' in relatedTarget &&
      event.currentTarget.contains(relatedTarget as Node)
    ) {
      return;
    }
    setDropTarget((current) => (current?.key === key ? null : current));
  };

  const handleLibraryDrop = async (
    event: ReactDragEvent<HTMLElement>,
    destination: LibraryDropDestination,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const materialId = getDraggedMaterialId(event.dataTransfer);
    if (destination.kind === 'invalid') {
      clearMaterialDrag();
      return;
    }
    const folderId = destination.kind === 'folder' ? destination.folderId : null;
    const state = resolveDropState(materialId, destination);
    if (state !== 'valid' || !materialId) {
      clearMaterialDrag();
      return;
    }
    try {
      await handleMoveMaterial(materialId, folderId);
    } finally {
      clearMaterialDrag();
    }
  };

  const handleMaterialDragStart = (
    event: ReactDragEvent<HTMLLIElement>,
    material: ReadingMaterial,
  ) => {
    if (!materialDraggingEnabled) {
      event.preventDefault();
      return;
    }
    draggedMaterialIdRef.current = material.id;
    setDraggedMaterialId(material.id);
    setDropTarget(null);
    writeLibraryMaterialDragPayload(event.dataTransfer, material.id);
  };

  const handleMaterialPointerDown = (
    event: ReactPointerEvent<HTMLLIElement>,
    material: ReadingMaterial,
  ) => {
    if (
      (event.pointerType !== 'mouse' && event.pointerType !== 'pen') ||
      event.button !== 0 ||
      pointerMaterialDragRef.current
    ) {
      return;
    }

    const source = event.currentTarget;
    const drag: PointerMaterialDragState = {
      pointerId: event.pointerId,
      materialId: material.id,
      source,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    pointerMaterialDragRef.current = drag;
    source.draggable = false;
    setPointerMaterialDragActive(true);

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      source.draggable = materialDraggingEnabled;
      document.body.classList.remove('is-library-material-dragging');
      setPointerMaterialDragActive(false);
      if (pointerMaterialDragRef.current === drag) pointerMaterialDragRef.current = null;
    };

    const handlePointerMove = (nativeEvent: PointerEvent) => {
      const current = pointerMaterialDragRef.current;
      if (!current || current.pointerId !== nativeEvent.pointerId) return;
      const distance = Math.hypot(
        nativeEvent.clientX - current.startX,
        nativeEvent.clientY - current.startY,
      );
      if (!current.active && distance < 6) return;
      nativeEvent.preventDefault();
      if (!current.active) {
        current.active = true;
        suppressMaterialClickRef.current = true;
        document.body.classList.add('is-library-material-dragging');
        setDraggedMaterialId(current.materialId);
      }
      const pointerTarget = getPointerDropTarget(nativeEvent.clientX, nativeEvent.clientY);
      if (!pointerTarget) {
        setDropTarget(null);
        return;
      }
      setDropTarget({
        key: pointerTarget.key,
        state: resolveDropState(current.materialId, pointerTarget.destination),
      });
    };

    const handlePointerUp = (nativeEvent: PointerEvent) => {
      const current = pointerMaterialDragRef.current;
      if (!current || current.pointerId !== nativeEvent.pointerId) return;
      const wasActive = current.active;
      cleanup();
      if (!wasActive) return;
      nativeEvent.preventDefault();
      const pointerTarget = getPointerDropTarget(nativeEvent.clientX, nativeEvent.clientY);
      const destination = pointerTarget?.destination;
      const state = destination ? resolveDropState(current.materialId, destination) : 'invalid';
      window.setTimeout(() => {
        suppressMaterialClickRef.current = false;
      }, 0);
      if (state !== 'valid' || !destination) {
        clearMaterialDrag();
        return;
      }
      const folderId = destination.kind === 'folder' ? destination.folderId : null;
      void handleMoveMaterial(current.materialId, folderId).finally(clearMaterialDrag);
    };

    const handlePointerCancel = (nativeEvent: PointerEvent) => {
      const current = pointerMaterialDragRef.current;
      if (!current || current.pointerId !== nativeEvent.pointerId) return;
      const wasActive = current.active;
      cleanup();
      if (wasActive) {
        window.setTimeout(() => {
          suppressMaterialClickRef.current = false;
        }, 0);
      }
      clearMaterialDrag();
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  };

  const handleMaterialDragEnd = (event: ReactDragEvent<HTMLLIElement>) => {
    event.stopPropagation();
    clearMaterialDrag();
  };

  const startCreateFolder = (parentId: string | null) => {
    if (parentId !== null) {
      const parent = folders.find((folder) => folder.id === parentId);
      if (!parent || getLibraryFolderDepth(parent.id, folders) >= MAX_LIBRARY_FOLDER_DEPTH) return;
      if (queryKey) {
        setSearchExpansionOverrides((current) => ({ ...current, [parentId]: true }));
      } else {
        void commands
          .execute(COMMAND_IDS.workbenchSetLibraryFolderExpanded, parentId, true)
          .catch(() => undefined);
      }
    }
    setFolderEditor({ kind: 'create', parentId, value: '', error: null });
  };

  const startRenameFolder = (folder: LibraryFolder) => {
    setFolderEditor({ kind: 'rename', folderId: folder.id, value: folder.name, error: null });
  };

  const startDeleteFolder = (folder: LibraryFolder) => {
    openFolderDeleteConfirm(
      folder.id,
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    );
  };

  const cancelFolderEdit = () => setFolderEditor(null);

  const saveFolderEdit = async () => {
    if (!folderEditor) return;
    try {
      if (folderEditor.kind === 'create') {
        const parentId = folderEditor.parentId;
        await commands.execute(COMMAND_IDS.libraryCreateFolder, folderEditor.value, parentId);
        if (parentId !== null) {
          if (queryKey) {
            setSearchExpansionOverrides((current) => ({ ...current, [parentId]: true }));
          } else {
            await commands.execute(COMMAND_IDS.workbenchSetLibraryFolderExpanded, parentId, true);
          }
        }
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
    if (queryKey) {
      setSearchExpansionOverrides((current) => ({ ...current, [folderId]: expanded }));
      return;
    }
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
              event.stopPropagation();
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

  const renderMaterialNode = (
    material: ReadingMaterial,
    level: number,
    parentKey: string | null,
  ): ReactNode => {
    const isUnfiledMaterial = parentKey === 'unfiled';
    const treeKey = `material:${material.id}`;
    const dropState = dropTarget?.key === treeKey ? dropTarget.state : undefined;
    const materialPath = searchResult.materialFolderPaths.get(material.id) ?? ['未归类'];
    const showSearchPath = queryKey !== '' && searchResult.matchingMaterialIds.has(material.id);
    const accessiblePath = materialPath.join(' / ');
    return (
      <li
        key={material.id}
        ref={(element) => {
          if (element) treeItemRefs.current.set(treeKey, element);
          else treeItemRefs.current.delete(treeKey);
        }}
        className="library-material-tree-node"
        data-material-display={isUnfiledMaterial ? 'unfiled' : 'folder'}
        role={isUnfiledMaterial ? undefined : 'treeitem'}
        aria-level={isUnfiledMaterial ? undefined : level}
        aria-label={`${material.title}${material.managedFileAvailable === false ? '，正文不可用' : ''}${showSearchPath ? `，路径 ${accessiblePath}` : ''}`}
        tabIndex={isUnfiledMaterial ? undefined : activeTreeItemKey === treeKey ? 0 : -1}
        data-drop-state={dropState}
        draggable={materialDraggingEnabled && !pointerMaterialDragActive}
        data-dragging={draggedMaterialId === material.id ? 'true' : undefined}
        onFocus={isUnfiledMaterial ? undefined : () => setFocusedTreeItemKey(treeKey)}
        onPointerDown={(event) => handleMaterialPointerDown(event, material)}
        onDragStart={(event) => handleMaterialDragStart(event, material)}
        onDragEnd={handleMaterialDragEnd}
        onDragEnter={(event) => updateDropTarget(event, treeKey, { kind: 'invalid' })}
        onDragOver={(event) => updateDropTarget(event, treeKey, { kind: 'invalid' })}
        onDragLeave={(event) => handleDropLeave(event, treeKey)}
        onDrop={(event) => void handleLibraryDrop(event, { kind: 'invalid' })}
        onKeyDown={isUnfiledMaterial ? undefined : (event) => handleTreeItemKeyDown(event, {
          key: treeKey,
          kind: 'material',
          materialId: material.id,
          parentKey,
          expandable: false,
          expanded: false,
        })}
      >
        <div
          className={isUnfiledMaterial
            ? 'relative library-unfiled-material-shell'
            : 'library-folder-material-shell'}
          onPointerEnter={() => {
            focusMaterial(material.id);
            setMoreMenuOpen(false);
            setMoveMenuOpen(false);
          }}
        >
          <button
            type="button"
            onClick={() => {
              if (suppressMaterialClickRef.current) {
                suppressMaterialClickRef.current = false;
                return;
              }
              focusMaterial(material.id);
              handleOpen(material.id);
            }}
            onFocus={() => focusMaterial(material.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                event.stopPropagation();
                return;
              }
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
            className={isUnfiledMaterial ? 'library-unfiled-material' : 'library-folder-material'}
          >
            {isUnfiledMaterial ? (
              <>
                <div className="min-w-0 flex-1">
                  <p className="library-unfiled-material-title truncate text-[11px] font-medium text-zinc-400">
                    {material.title}
                  </p>
                  <p className="truncate text-[10px] text-zinc-600">
                    {material.author ?? '未知作者'}
                  </p>
                  {showSearchPath ? (
                    <p className="library-material-path truncate" title={`路径：${accessiblePath}`}>
                      路径：{accessiblePath}
                    </p>
                  ) : null}
                  {material.managedFileAvailable === false ? (
                    <p className="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-amber-300">
                      <FileWarning size={10} aria-hidden />
                      正文不可用
                    </p>
                  ) : null}
                </div>
              </>
            ) : (
              <span className="library-folder-material-copy">
                <span className="library-folder-material-title" title={material.title}>
                  {material.title}
                </span>
                {showSearchPath ? (
                  <span className="library-folder-material-path" title={`路径：${accessiblePath}`}>
                    路径：{accessiblePath}
                  </span>
                ) : null}
              </span>
            )}
          </button>
          {dropState ? (
            <span className="library-drop-feedback" role="status" aria-live="polite">
              {libraryDropStateLabel(dropState)}
            </span>
          ) : null}
        </div>
      </li>
    );
  };

  const renderFolderNode = (
    folder: LibraryFolder,
    level: number,
    parentKey: string | null,
  ): ReactNode => {
    if (!visibleFolderIds.has(folder.id)) return null;
    const children = (folderChildren.get(folder.id) ?? []).filter((child) => visibleFolderIds.has(child.id));
    const folderMaterials = sortMaterialsByTitle(
      materials.filter(
        (material) => material.folderId === folder.id && visibleMaterialIds.has(material.id),
      ),
    );
    const editingChild = folderEditor?.kind === 'create' && folderEditor.parentId === folder.id;
    const editingSelf = folderEditor?.kind === 'rename' && folderEditor.folderId === folder.id;
    const treeKey = `folder:${folder.id}`;
    const expanded = isFolderExpanded(folder.id) || editingChild || editingSelf;
    const canCreateChild = getLibraryFolderDepth(folder.id, folders) < MAX_LIBRARY_FOLDER_DEPTH;
    const dropState = dropTarget?.key === treeKey ? dropTarget.state : undefined;
    return (
      <li
        key={folder.id}
        ref={(element) => {
          if (element) treeItemRefs.current.set(treeKey, element);
          else treeItemRefs.current.delete(treeKey);
        }}
        className="library-folder-tree-item"
        role="treeitem"
        aria-level={level}
        aria-label={`文件夹 ${folder.name}`}
        aria-expanded={expanded}
        tabIndex={activeTreeItemKey === treeKey ? 0 : -1}
        data-drop-state={dropState}
        data-library-drop-target="folder"
        data-library-folder-id={folder.id}
        onFocus={() => setFocusedTreeItemKey(treeKey)}
        onDragEnter={(event) => updateDropTarget(event, treeKey, { kind: 'folder', folderId: folder.id })}
        onDragOver={(event) => updateDropTarget(event, treeKey, { kind: 'folder', folderId: folder.id })}
        onDragLeave={(event) => handleDropLeave(event, treeKey)}
        onDrop={(event) => void handleLibraryDrop(event, { kind: 'folder', folderId: folder.id })}
        onKeyDown={(event) => handleTreeItemKeyDown(event, {
          key: treeKey,
          kind: 'folder',
          folderId: folder.id,
          parentKey,
          expandable: children.length > 0 || folderMaterials.length > 0,
          expanded,
        })}
      >
        <div className="library-folder-row">
          <button
            type="button"
            className="library-folder-toggle"
            aria-label={`${expanded ? '收起' : '展开'}文件夹 ${folder.name}`}
            aria-expanded={expanded}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                event.stopPropagation();
              }
            }}
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
              onKeyDown={(event) => event.stopPropagation()}
              onClick={() => startCreateFolder(folder.id)}
            >
              <FolderPlus size={14} aria-hidden />
            </button>
            <button type="button" aria-label={`重命名 ${folder.name}`} title="重命名文件夹" onKeyDown={(event) => event.stopPropagation()} onClick={() => startRenameFolder(folder)}>
              <Pencil size={13} aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`删除 ${folder.name}`}
              title="删除文件夹及其子文件夹"
              onKeyDown={(event) => event.stopPropagation()}
              onClick={() => startDeleteFolder(folder)}
            >
              <Trash2 size={13} aria-hidden />
            </button>
          </div>
          {dropState ? (
            <span className="library-drop-feedback" role="status" aria-live="polite">
              {libraryDropStateLabel(dropState)}
            </span>
          ) : null}
        </div>
        {expanded ? (
          <ul className="library-folder-group" role="group">
            {editingSelf ? renderFolderEditor(level + 1) : null}
            {children.map((child) => renderFolderNode(child, level + 1, treeKey))}
            {folderMaterials.map((material) => renderMaterialNode(material, level + 1, treeKey))}
            {editingChild ? renderFolderEditor(level + 1) : null}
            {children.length === 0 && folderMaterials.length === 0 ? (
              <li className="library-tree-empty library-folder-empty">文件夹为空</li>
            ) : null}
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
                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={moveMenuOpen}
                    onClick={() => setMoveMenuOpen((open) => !open)}
                  >
                    <Folder size={14} aria-hidden />
                    <span>移动到…</span>
                    <span className="library-menu-item-trailing" aria-hidden>›</span>
                  </button>
                  {moveMenuOpen ? (
                    <div
                      role="group"
                      aria-label="移动到目标文件夹"
                      className="library-move-menu"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        aria-label="移动到未归类"
                        aria-current={focusedMaterial.folderId === null ? 'location' : undefined}
                        onClick={() => void handleMoveMaterial(focusedMaterial.id, null)}
                      >
                        <FolderOpen size={14} aria-hidden />
                        <span>未归类</span>
                        {focusedMaterial.folderId === null ? <Check size={13} aria-hidden /> : null}
                      </button>
                      {moveFolderOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          role="menuitem"
                          aria-label={`移动到 ${option.label}`}
                          aria-current={focusedMaterial.folderId === option.id ? 'location' : undefined}
                          style={{ paddingLeft: `${10 + Math.min(option.depth - 1, 4) * 10}px` }}
                          onClick={() => void handleMoveMaterial(focusedMaterial.id, option.id)}
                        >
                          {option.depth > 1 ? <Folder size={14} aria-hidden /> : <FolderOpen size={14} aria-hidden />}
                          <span>{option.label}</span>
                          {focusedMaterial.folderId === option.id ? <Check size={13} aria-hidden /> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
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
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query.length > 0) {
                  event.preventDefault();
                  setQuery('');
                }
              }}
              placeholder="按文件夹、标题或作者筛选…"
              aria-label="筛选书库"
              className="library-filter-input w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-7 pr-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>
      ) : null}

      <div className="library-tree-scroll">
        <ul className="library-tree" role="tree" aria-label="书库文件夹树">
          {folderEditor?.kind === 'create' && folderEditor.parentId === null ? renderFolderEditor(1) : null}
          {rootFolders.map((folder) => renderFolderNode(folder, 1, null))}
          {queryKey !== '' && visibleFolderIds.size === 0 && unfiledMaterials.length === 0 ? (
            <li className="library-tree-empty">
              <p>没有匹配的材料</p>
              <span>换个文件夹、标题或作者试试。</span>
            </li>
          ) : null}
        </ul>
      </div>

      {queryKey === '' || unfiledMaterials.length > 0 ? (
        <div
          className="border-t border-zinc-800 library-unfiled-section"
          data-drop-state={unfiledDropState}
          data-library-drop-target="unfiled"
          onDragEnter={(event) => updateDropTarget(event, 'unfiled', { kind: 'unfiled' })}
          onDragOver={(event) => updateDropTarget(event, 'unfiled', { kind: 'unfiled' })}
          onDragLeave={(event) => handleDropLeave(event, 'unfiled')}
          onDrop={(event) => void handleLibraryDrop(event, { kind: 'unfiled' })}
        >
          <button
            type="button"
            onClick={() => toggleUnfiled(!unfiledExpanded)}
            aria-expanded={unfiledExpanded}
            aria-label={`${unfiledExpanded ? '收起' : '展开'}未归类材料`}
            className="library-bottom-section-toggle flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
          >
            <FolderOpen size={14} aria-hidden />
            未归类
            <span className="ml-auto rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {unfiledMaterials.length}
            </span>
            {unfiledDropState ? (
              <span className="library-drop-feedback" role="status" aria-live="polite">
                {libraryDropStateLabel(unfiledDropState)}
              </span>
            ) : null}
          </button>
          {unfiledExpanded && (unfiledMaterials.length > 0 || materials.length === 0) ? (
            <ul className="max-h-56 overflow-y-auto border-t border-zinc-800/60 px-2 py-1">
              {materials.length === 0 ? (
                <li className="library-tree-empty">
                  <p>尚未导入阅读材料</p>
                  <span>点击右上角导入按钮选择 EPUB、PDF 或 Markdown。外部原文件不会被修改或删除。</span>
                </li>
              ) : (
                unfiledMaterials.map((material) => renderMaterialNode(material, 0, 'unfiled'))
              )}
            </ul>
          ) : null}
        </div>
      ) : null}

      {trashedMaterials.length > 0 ? (
        <div className="border-t border-zinc-800">
          <button
            type="button"
            onClick={() => setShowTrash((visible) => !visible)}
            aria-expanded={showTrash}
            className="library-bottom-section-toggle flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
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
