import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from '../workbench/libraryStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';

type MenuKey = 'file' | 'edit' | 'view' | null;

interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: false;
}

interface MenuSeparator {
  id: string;
  separator: true;
}

type ApplicationMenuItem = MenuItem | MenuSeparator;

/** 生产工作台的应用导航层。菜单只负责把用户意图交给稳定 Command。 */
export function ApplicationBar() {
  const { commands } = useAppServices();
  const menuAreaRef = useRef<HTMLDivElement | null>(null);
  const [openMenu, setOpenMenu] = useState<MenuKey>(null);
  const activeViewId = useWorkspaceStore((state) => {
    const group = state.editorGroups.find((candidate) => candidate.id === state.activeEditorGroupId);
    return group?.activeViewId ?? null;
  });
  const activeMaterialId = useWorkspaceStore((state) => {
    const group = state.editorGroups.find((candidate) => candidate.id === state.activeEditorGroupId);
    const view = group?.views.find((candidate) => candidate.id === group.activeViewId);
    return view?.materialId ?? null;
  });
  const activeMaterial = useLibraryStore((state) =>
    state.materials.find((material) => material.id === activeMaterialId),
  );
  const primarySidebarVisible = useWorkspaceStore((state) => state.primarySidebarVisible);
  const tocVisible = useWorkspaceStore((state) => state.tocVisible);
  const editorGroupCount = useWorkspaceStore((state) => state.editorGroups.length);

  useEffect(() => {
    if (!openMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuAreaRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    const firstItem = menuAreaRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    firstItem?.focus();
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  const execute = (commandId: Parameters<typeof commands.execute>[0], ...args: unknown[]) => {
    void commands.execute(commandId, ...args).catch(() => undefined);
    setOpenMenu(null);
  };

  const menuItems = (menu: Exclude<MenuKey, null>): ApplicationMenuItem[] => {
    if (menu === 'file') {
      return [
        { id: 'import', label: '导入阅读材料…' },
        { id: 'separator-1', separator: true },
        { id: 'backup', label: '导出完整备份…' },
        { id: 'restore', label: '恢复完整备份…' },
        { id: 'separator-2', separator: true },
        { id: 'close', label: '关闭当前标签', disabled: !activeViewId },
      ];
    }
    if (menu === 'edit') {
      return [
        { id: 'library-filter', label: '聚焦书库筛选' },
        { id: 'current-search', label: '搜索当前材料', shortcut: 'Ctrl+F', disabled: !activeViewId },
      ];
    }
    return [
      { id: 'library', label: '书库', checked: primarySidebarVisible },
      { id: 'toc', label: '目录', checked: tocVisible },
      { id: 'separator-1', separator: true },
      {
        id: 'split-right',
        label: '向右拆分编辑器',
        disabled: editorGroupCount >= 2,
      },
      { id: 'typography', label: '阅读排版…', disabled: !activeViewId },
    ];
  };

  const handleMenuItem = (menu: Exclude<MenuKey, null>, id: string) => {
    switch (`${menu}:${id}`) {
      case 'file:import':
        execute(COMMAND_IDS.libraryImport);
        break;
      case 'file:backup':
        execute(COMMAND_IDS.libraryExportBackup);
        break;
      case 'file:restore':
        execute(COMMAND_IDS.libraryRestoreBackup);
        break;
      case 'file:close':
        if (activeViewId) execute(COMMAND_IDS.readerCloseView, activeViewId);
        break;
      case 'edit:library-filter':
        execute(COMMAND_IDS.workbenchFocusLibraryFilter);
        break;
      case 'edit:current-search':
        execute(COMMAND_IDS.readerSearchOpen, activeViewId);
        break;
      case 'view:library':
        execute(COMMAND_IDS.workbenchTogglePrimarySidebar);
        break;
      case 'view:toc':
        execute(COMMAND_IDS.workbenchToggleToc);
        break;
      case 'view:split-right':
        execute(COMMAND_IDS.workbenchSplitEditorGroupRight);
        break;
      case 'view:typography':
        execute(COMMAND_IDS.readerOpenTypography);
        break;
    }
  };

  return (
    <header ref={menuAreaRef} role="banner" aria-label="应用顶栏" className="app-topbar frosted-zone">
      <div className="app-topbar-start">
        <span className="app-mark" aria-label="AI Reader">
          <BookOpen size={16} aria-hidden />
        </span>
        <button type="button" aria-label="应用后退" title="应用后退" onClick={() => execute(COMMAND_IDS.readerBack)}>
          <ArrowLeft size={17} aria-hidden />
        </button>
        <button type="button" aria-label="应用前进" title="应用前进" onClick={() => execute(COMMAND_IDS.readerForward)}>
          <ArrowRight size={17} aria-hidden />
        </button>
        {(['file', 'edit', 'view'] as const).map((menu) => {
          const label = menu === 'file' ? '文件' : menu === 'edit' ? '编辑' : '视图';
          const open = openMenu === menu;
          return (
            <div className="app-menu-anchor" key={menu}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                className="app-menu-trigger"
                onClick={() => setOpenMenu(open ? null : menu)}
              >
                {label}
                <ChevronDown size={13} aria-hidden />
              </button>
              {open ? (
                <div role="menu" aria-label={`${label}菜单`} className="app-menu">
                  {menuItems(menu).map((item) =>
                    item.separator ? (
                      <div role="separator" className="app-menu-separator" key={item.id} />
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        key={item.id}
                        disabled={item.disabled}
                        aria-checked={item.checked}
                        onClick={() => handleMenuItem(menu, item.id)}
                      >
                        <span className="app-menu-check" aria-hidden>
                          {item.checked ? <Check size={13} /> : null}
                        </span>
                        <span>{item.label}</span>
                        {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="app-topbar-document" title={activeMaterial?.title ?? 'AI Reader'}>
        <span>{activeMaterial?.title ?? 'AI Reader'}</span>
        <small>阅读工作区</small>
      </div>
      <div className="app-topbar-status" aria-live="polite">
        <span>{activeMaterial ? '正在阅读' : '本地书库'}</span>
      </div>
    </header>
  );
}
