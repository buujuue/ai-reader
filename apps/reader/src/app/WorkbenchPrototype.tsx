import {
  ArrowLeft,
  ArrowRight,
  BookMarked,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  FolderPlus,
  GripVertical,
  LibraryBig,
  ListTree,
  Minus,
  MoreHorizontal,
  Moon,
  Palette,
  PanelLeftClose,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Square,
  Sparkles,
  StickyNote,
  Sun,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import './workbenchPrototype.css';

type ThemeMode = 'midnight' | 'apple' | 'claude' | 'mint' | 'rose';
type ActivityPanel = 'library' | 'toc' | 'interface' | null;
type MenuKey = 'file' | 'edit' | 'view' | null;
type InterfaceScope = 'book' | 'global';
type ReadingFontFamily = 'default' | 'serif' | 'sans';
type ReadingViewMode = 'single' | 'double';

const MAX_FOLDER_DEPTH = 5;

interface PrototypeTheme {
  description: string;
  id: ThemeMode;
  label: string;
}

const PROTOTYPE_THEMES: readonly PrototypeTheme[] = [
  { id: 'midnight', label: '极夜黑', description: '默认 · 蓝紫环境光' },
  { id: 'apple', label: '苹果白', description: '通透冷白 · 系统蓝' },
  { id: 'claude', label: 'Claude 护眼', description: '暖纸米色 · 陶土橙' },
  { id: 'mint', label: '清新绿', description: '低饱和绿 · 自然呼吸感' },
  { id: 'rose', label: '柔雾粉', description: '克制豆沙粉 · 柔和安静' },
];

interface PrototypeBook {
  id: string;
  title: string;
  author: string;
  format: 'EPUB' | 'PDF' | 'MD';
  progress: number;
}

interface PrototypeFolder {
  id: string;
  name: string;
  children: PrototypeFolder[];
  books: PrototypeBook[];
}

interface SharedPrototypeState {
  activePanel: ActivityPanel;
  activeBookId: string;
  folders: PrototypeFolder[];
  glowEnabled: boolean;
  interfaceScope: InterfaceScope;
  leftWidth: number;
  agentVisible: boolean;
  query: string;
  readingFontFamily: ReadingFontFamily;
  readingFontSize: number;
  readingFontWeight: number;
  readingLineHeight: number;
  readingViewMode: ReadingViewMode;
  readingZoom: number;
  readingWidth: number;
  rightWidth: number;
  theme: ThemeMode;
}

interface SharedPrototypeActions {
  addFolder: (parentId?: string) => void;
  moveBook: (bookId: string, folderId: string) => void;
  selectBook: (bookId: string) => void;
  setActivePanel: (panel: ActivityPanel) => void;
  setAgentVisible: (visible: boolean) => void;
  setGlowEnabled: (enabled: boolean) => void;
  setInterfaceScope: (scope: InterfaceScope) => void;
  setLeftWidth: (width: number) => void;
  setQuery: (query: string) => void;
  setReadingFontFamily: (fontFamily: ReadingFontFamily) => void;
  setReadingFontSize: (fontSize: number) => void;
  setReadingFontWeight: (fontWeight: number) => void;
  setReadingLineHeight: (lineHeight: number) => void;
  setReadingViewMode: (viewMode: ReadingViewMode) => void;
  setReadingZoom: (zoom: number) => void;
  setReadingWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  setTheme: (theme: ThemeMode) => void;
  showStatus: (message: string) => void;
}

interface PrototypeMenuItem {
  action: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  shortcut?: string;
}

const folder = (id: string, name: string, children: PrototypeFolder[] = [], books: PrototypeBook[] = []) => ({
  id,
  name,
  children,
  books,
});

const book = (
  id: string,
  title: string,
  author: string,
  format: PrototypeBook['format'],
  progress: number,
): PrototypeBook => ({ id, title, author, format, progress });

const INITIAL_FOLDERS: PrototypeFolder[] = [
  folder('reading', '正在阅读', [], [
    book('sapiens', '人类简史', '尤瓦尔·赫拉利', 'EPUB', 68),
    book('discipline', '规训与惩罚', '米歇尔·福柯', 'PDF', 34),
    book('reader-notes', '阅读札记', '我的笔记', 'MD', 12),
  ]),
  folder('history', '历史与文明', [
    folder('europe', '欧洲史', [
      folder('modern-europe', '近代欧洲', [
        folder('revolution', '法国大革命', [
          folder('paris-commune', '巴黎公社', [], [
            book('meditations', '沉思录', '马可·奥勒留', 'EPUB', 81),
            book('history-time', '时间的秩序', '卡洛·罗韦利', 'EPUB', 23),
          ]),
        ]),
      ]),
    ]),
  ]),
  folder('tools', '技术与工具', [
    folder('frontend', '前端工程', [], [
      book('design-systems', '设计系统工作手册', '团队资料', 'PDF', 47),
      book('typescript', 'TypeScript 深入理解', '技术资料', 'MD', 9),
    ]),
  ]),
];

const ARTICLE_PARAGRAPHS = [
  '阅读并不只是把文字从页面搬进记忆。真正发生的，是读者不断把眼前的信息放回自己的经验坐标：哪些内容值得停留，哪些观点需要质疑，哪些段落会改变后续的理解。',
  '一个好的阅读工作台应该把这些动作放在同一条连续路径上。目录负责定位，书库负责组织，批注负责保存判断，而正文始终占据视觉中心。工具存在，但不应比材料本身更响亮。',
  '因此，界面的密度需要保持克制。侧栏可以容纳很多信息，却只在需要时出现；同一区域只展示一种任务；用户调整后的宽度则成为工作习惯的一部分，而不是每次重新适应的临时布局。',
];

function cloneFolders(items: PrototypeFolder[]): PrototypeFolder[] {
  return items.map((item) => ({
    ...item,
    children: cloneFolders(item.children),
    books: item.books.map((itemBook) => ({ ...itemBook })),
  }));
}

export function WorkbenchPrototype() {
  const [theme, setTheme] = useState<ThemeMode>('midnight');
  const [glowEnabled, setGlowEnabled] = useState(true);
  const [interfaceScope, setInterfaceScope] = useState<InterfaceScope>('book');
  const [activePanel, setActivePanel] = useState<ActivityPanel>('library');
  const [folders, setFolders] = useState<PrototypeFolder[]>(() => cloneFolders(INITIAL_FOLDERS));
  const [activeBookId, setActiveBookId] = useState('sapiens');
  const [agentVisible, setAgentVisible] = useState(true);
  const [leftWidth, setLeftWidth] = useState(304);
  const [rightWidth, setRightWidth] = useState(294);
  const [query, setQuery] = useState('');
  const [readingFontFamily, setReadingFontFamily] = useState<ReadingFontFamily>('default');
  const [readingFontSize, setReadingFontSize] = useState(16);
  const [readingFontWeight, setReadingFontWeight] = useState(400);
  const [readingLineHeight, setReadingLineHeight] = useState(1.95);
  const [readingViewMode, setReadingViewMode] = useState<ReadingViewMode>('double');
  const [readingZoom, setReadingZoom] = useState(100);
  const [readingWidth, setReadingWidth] = useState(680);
  const [statusMessage, setStatusMessage] = useState('就绪');
  const statusTimer = useRef<number | null>(null);

  const showStatus = (message: string) => {
    setStatusMessage(message);
    if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatusMessage('就绪'), 2600);
  };

  useEffect(
    () => () => {
      if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
    },
    [],
  );

  const moveBook = (bookId: string, folderId: string) => {
    const removed = removeBook(folders, bookId);
    if (!removed.book) return;
    const nextFolders = appendBook(removed.folders, folderId, removed.book);
    setFolders(nextFolders);
    const target = findFolder(nextFolders, folderId);
    showStatus(`已将《${removed.book.title}》移动到“${target?.name ?? '目标文件夹'}”`);
  };

  const addFolder = (parentId?: string) => {
    const parentDepth = parentId ? folderDepth(folders, parentId) : 0;
    if (parentDepth >= MAX_FOLDER_DEPTH) {
      showStatus(`文件夹最多支持 ${MAX_FOLDER_DEPTH} 层`);
      return;
    }
    const nextNumber = countFolders(folders, '新建文件夹') + 1;
    const nextFolder = folder(`custom-${Date.now()}`, `新建文件夹 ${nextNumber}`);
    setFolders((current) => (parentId ? appendChild(current, parentId, nextFolder) : [...current, nextFolder]));
    showStatus(parentId ? '已创建子文件夹' : '已创建顶层文件夹');
  };

  const state: SharedPrototypeState = {
    activePanel,
    activeBookId,
    folders,
    glowEnabled,
    interfaceScope,
    leftWidth,
    agentVisible,
    query,
    readingFontFamily,
    readingFontSize,
    readingFontWeight,
    readingLineHeight,
    readingViewMode,
    readingZoom,
    readingWidth,
    rightWidth,
    theme,
  };

  const actions: SharedPrototypeActions = {
    addFolder,
    moveBook,
    selectBook: (bookId) => {
      setActiveBookId(bookId);
      showStatus('已在当前工作区打开阅读材料');
    },
    setActivePanel,
    setAgentVisible,
    setGlowEnabled,
    setInterfaceScope,
    setLeftWidth,
    setQuery,
    setReadingFontFamily,
    setReadingFontSize,
    setReadingFontWeight,
    setReadingLineHeight,
    setReadingViewMode,
    setReadingZoom,
    setReadingWidth,
    setRightWidth,
    setTheme,
    showStatus,
  };

  return (
    <div
      className="workbench-prototype"
      data-theme={theme}
      data-glow={glowEnabled ? 'on' : 'off'}
      data-variant="C"
    >
      <a className="prototype-skip-link" href="#prototype-reader-main">
        跳到阅读正文
      </a>
      <VariantC state={state} actions={actions} />
      <div className="prototype-status-message" role="status" aria-live="polite">
        {statusMessage}
      </div>
    </div>
  );
}

function VariantC({ state, actions }: { state: SharedPrototypeState; actions: SharedPrototypeActions }) {
  return (
    <div className="prototype-variant variant-c">
      <TitleBar state={state} actions={actions} />
      <div className="variant-c-body">
        <div className="variant-c-left-cluster frosted-zone">
          <ActivityRail state={state} actions={actions} />
          {state.activePanel ? <PrimaryPanel state={state} actions={actions} /> : null}
        </div>
        {state.activePanel ? (
          <ResizeHandle
            label="调整主侧栏宽度"
            side="left"
            value={state.leftWidth}
            min={244}
            max={460}
            onChange={actions.setLeftWidth}
          />
        ) : null}
        <main id="prototype-reader-main" className="reader-stage reader-stage-c" tabIndex={-1}>
          <ReaderCanvas state={state} actions={actions} />
        </main>
        {state.agentVisible ? (
          <div className="variant-c-right-cluster">
            <ResizeHandle
              label="调整 Agent 侧栏宽度"
              side="right"
              value={state.rightWidth}
              min={230}
              max={470}
              onChange={actions.setRightWidth}
            />
            <AgentPanel state={state} actions={actions} />
          </div>
        ) : null}
      </div>
      <WorkbenchStatus state={state} />
    </div>
  );
}

function TitleBar({ state, actions }: { state: SharedPrototypeState; actions: SharedPrototypeActions }) {
  const [openMenu, setOpenMenu] = useState<MenuKey>(null);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const menuAreaRef = useRef<HTMLDivElement | null>(null);
  const themePickerRef = useRef<HTMLDivElement | null>(null);
  const activeBook = findBook(state.folders, state.activeBookId);

  useEffect(() => {
    const closePopovers = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuAreaRef.current?.contains(target)) setOpenMenu(null);
      if (!themePickerRef.current?.contains(target)) setThemePickerOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (themePickerRef.current?.contains(document.activeElement)) {
        themePickerRef.current.querySelector<HTMLButtonElement>('.theme-picker-trigger')?.focus();
      }
      setOpenMenu(null);
      setThemePickerOpen(false);
    };
    document.addEventListener('mousedown', closePopovers);
    window.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('mousedown', closePopovers);
      window.removeEventListener('keydown', closeWithEscape);
    };
  }, []);

  const handleMenuAction = (action: string) => {
    setOpenMenu(null);
    switch (action) {
      case 'import':
        actions.showStatus('文件 → 导入阅读材料');
        break;
      case 'backup':
        actions.showStatus('文件 → 导出完整备份');
        break;
      case 'restore':
        actions.showStatus('文件 → 恢复完整备份');
        break;
      case 'find':
        actions.setActivePanel('library');
        window.setTimeout(() => document.querySelector<HTMLInputElement>('#prototype-library-search')?.focus(), 0);
        break;
      case 'toggle-primary':
        actions.setActivePanel(state.activePanel ? null : 'library');
        break;
      case 'toggle-agent':
        actions.setAgentVisible(!state.agentVisible);
        break;
      case 'theme-picker':
        setThemePickerOpen(true);
        break;
      case 'split':
        actions.showStatus('视图 → 向右拆分编辑器');
        break;
      default:
        actions.showStatus('该操作暂不可用');
    }
  };

  return (
    <header className="prototype-titlebar frosted-zone" data-tauri-drag-region>
      <div className="titlebar-left" ref={menuAreaRef}>
        <button className="app-mark" type="button" aria-label="AI Reader 应用菜单" title="AI Reader">
          <BookOpen size={16} aria-hidden />
        </button>
        <button type="button" aria-label="后退" title="后退" onClick={() => actions.showStatus('后退')}>
          <ArrowLeft size={17} aria-hidden />
        </button>
        <button type="button" aria-label="前进" title="前进" onClick={() => actions.showStatus('前进')}>
          <ArrowRight size={17} aria-hidden />
        </button>
        <MenuButton label="文件" menuKey="file" openMenu={openMenu} setOpenMenu={setOpenMenu} onAction={handleMenuAction} />
        <MenuButton label="编辑" menuKey="edit" openMenu={openMenu} setOpenMenu={setOpenMenu} onAction={handleMenuAction} />
        <MenuButton label="视图" menuKey="view" openMenu={openMenu} setOpenMenu={setOpenMenu} onAction={handleMenuAction} state={state} />
      </div>
      <div className="titlebar-document" data-tauri-drag-region>
        <BookMarked size={14} aria-hidden />
        <span>{activeBook?.title ?? 'AI Reader'}</span>
        <span className="titlebar-variant">工作区</span>
      </div>
      <div className="titlebar-end">
        <ThemePicker
          theme={state.theme}
          glowEnabled={state.glowEnabled}
          open={themePickerOpen}
          pickerRef={themePickerRef}
          onOpenChange={(open) => {
            setOpenMenu(null);
            setThemePickerOpen(open);
          }}
          onSelect={(theme) => {
            actions.setTheme(theme);
            actions.showStatus(`已切换到${getPrototypeTheme(theme).label}主题`);
          }}
          onGlowChange={(enabled) => {
            actions.setGlowEnabled(enabled);
            actions.showStatus(enabled ? '已开启背景光效果' : '已关闭背景光效果');
          }}
        />
        <div className="window-controls" aria-label="窗口控制">
          <button type="button" aria-label="最小化" title="最小化"><Minus size={16} aria-hidden /></button>
          <button type="button" aria-label="最大化或还原" title="最大化或还原"><Square size={12} aria-hidden /></button>
          <button className="window-close" type="button" aria-label="关闭" title="关闭"><X size={17} aria-hidden /></button>
        </div>
      </div>
    </header>
  );
}

function ThemePicker({
  theme,
  glowEnabled,
  open,
  pickerRef,
  onOpenChange,
  onSelect,
  onGlowChange,
}: {
  theme: ThemeMode;
  glowEnabled: boolean;
  open: boolean;
  pickerRef: React.RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onSelect: (theme: ThemeMode) => void;
  onGlowChange: (enabled: boolean) => void;
}) {
  const currentTheme = getPrototypeTheme(theme);
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => selectedOptionRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div className="theme-picker" ref={pickerRef}>
      <button
        className="theme-picker-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="切换工作台主题"
        onClick={() => onOpenChange(!open)}
      >
        <Palette size={15} aria-hidden />
        <span>{currentTheme.label}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {open ? (
        <div className="theme-picker-popover" role="dialog" aria-label="选择工作台主题">
          <header>
            <div>
              <strong>工作台主题</strong>
              <span>原型预览 · 不保存设置</span>
            </div>
          </header>
          <ThemeGlowToggle glowEnabled={glowEnabled} onChange={() => onGlowChange(!glowEnabled)} />
          <ThemeOptionList theme={theme} onSelect={onSelect} selectedOptionRef={selectedOptionRef} />
        </div>
      ) : null}
    </div>
  );
}

function ThemeGlowToggle({ glowEnabled, onChange }: { glowEnabled: boolean; onChange: () => void }) {
  return (
    <button
      className={glowEnabled ? 'theme-glow-toggle is-on' : 'theme-glow-toggle'}
      type="button"
      role="switch"
      aria-checked={glowEnabled}
      onClick={onChange}
    >
      <span className="theme-glow-icon" aria-hidden><Sparkles size={15} /></span>
      <span className="theme-glow-copy">
        <strong>背景光效果</strong>
        <small>{glowEnabled ? '已开启 · 每套配色使用对应光晕' : '已关闭 · 使用纯色渐变背景'}</small>
      </span>
      <span className="theme-glow-state">{glowEnabled ? '开启' : '关闭'}</span>
    </button>
  );
}

function ThemeOptionList({
  theme,
  onSelect,
  selectedOptionRef,
}: {
  theme: ThemeMode;
  onSelect: (theme: ThemeMode) => void;
  selectedOptionRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="theme-option-list">
      {PROTOTYPE_THEMES.map((option) => {
        const selected = option.id === theme;
        return (
          <button
            key={option.id}
            ref={selected ? selectedOptionRef : undefined}
            className={selected ? 'theme-option selected' : 'theme-option'}
            type="button"
            data-theme-option={option.id}
            aria-pressed={selected}
            onClick={() => onSelect(option.id)}
          >
            <span className="theme-option-preview" aria-hidden>
              <span />
            </span>
            <span className="theme-option-copy">
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </span>
            <span className="theme-option-check" aria-hidden>{selected ? <Check size={15} /> : null}</span>
          </button>
        );
      })}
    </div>
  );
}

function MenuButton({
  label,
  menuKey,
  openMenu,
  setOpenMenu,
  onAction,
  state,
}: {
  label: string;
  menuKey: Exclude<MenuKey, null>;
  openMenu: MenuKey;
  setOpenMenu: (key: MenuKey) => void;
  onAction: (action: string) => void;
  state?: SharedPrototypeState;
}) {
  const open = openMenu === menuKey;
  return (
    <div className="menu-anchor">
      <button
        className={open ? 'menu-trigger active' : 'menu-trigger'}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpenMenu(open ? null : menuKey)}
      >
        {label}
      </button>
      {open ? (
        <div className="app-menu" role="menu" aria-label={`${label}菜单`}>
          {getMenuItems(menuKey, state).map((item, index) =>
            item.separator ? (
              <div className="menu-separator" role="separator" key={`separator-${index}`} />
            ) : (
              <button type="button" role="menuitem" key={item.action} disabled={item.disabled} onClick={() => onAction(item.action)}>
                <span className="menu-check" aria-hidden>{item.checked ? <Check size={13} /> : null}</span>
                <span>{item.label}</span>
                {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function getMenuItems(menu: Exclude<MenuKey, null>, state?: SharedPrototypeState): PrototypeMenuItem[] {
  if (menu === 'file') {
    return [
      { action: 'import', label: '导入阅读材料…', shortcut: 'Ctrl+O' },
      { action: 'new-markdown', label: '新建 Markdown', shortcut: 'Ctrl+N' },
      { separator: true, action: '', label: '' },
      { action: 'backup', label: '导出完整备份…' },
      { action: 'restore', label: '恢复完整备份…' },
      { separator: true, action: '', label: '' },
      { action: 'close', label: '关闭当前标签', shortcut: 'Ctrl+W' },
      { action: 'exit', label: '退出 AI Reader', shortcut: 'Alt+F4' },
    ];
  }
  if (menu === 'edit') {
    return [
      { action: 'undo', label: '撤销', shortcut: 'Ctrl+Z' },
      { action: 'redo', label: '重做', shortcut: 'Ctrl+Y' },
      { separator: true, action: '', label: '' },
      { action: 'find', label: '在书库中查找', shortcut: 'Ctrl+P' },
      { action: 'find-current', label: '在当前材料中查找', shortcut: 'Ctrl+F' },
      { separator: true, action: '', label: '' },
      { action: 'metadata', label: '编辑资料信息…' },
    ];
  }
  return [
    { action: 'toggle-primary', label: '主侧栏', shortcut: 'Ctrl+B', checked: Boolean(state?.activePanel) },
    { action: 'toggle-agent', label: 'Agent 侧栏', checked: Boolean(state?.agentVisible) },
    { action: 'split', label: '向右拆分编辑器', shortcut: 'Ctrl+\\' },
    { separator: true, action: '', label: '' },
    { action: 'theme-picker', label: `主题配色：${getPrototypeTheme(state?.theme ?? 'midnight').label}` },
    { action: 'typography', label: '阅读排版…' },
    { action: 'fullscreen', label: '全屏', shortcut: 'F11' },
  ];
}

function ActivityRail({ state, actions }: { state: SharedPrototypeState; actions: SharedPrototypeActions }) {
  const togglePanel = (panel: Exclude<ActivityPanel, null>) => {
    actions.setActivePanel(state.activePanel === panel ? null : panel);
  };
  return (
    <nav className="prototype-activity-rail" aria-label="活动栏">
      <button type="button" aria-label="书库" title="书库" aria-pressed={state.activePanel === 'library'} className={state.activePanel === 'library' ? 'active' : ''} onClick={() => togglePanel('library')}>
        <LibraryBig size={20} aria-hidden /><span>书库</span>
      </button>
      <button type="button" aria-label="目录" title="目录" aria-pressed={state.activePanel === 'toc'} className={state.activePanel === 'toc' ? 'active' : ''} onClick={() => togglePanel('toc')}>
        <ListTree size={20} aria-hidden /><span>目录</span>
      </button>
      <button type="button" aria-label="界面" title="界面" aria-pressed={state.activePanel === 'interface'} className={state.activePanel === 'interface' ? 'active' : ''} onClick={() => togglePanel('interface')}>
        <SlidersHorizontal size={20} aria-hidden /><span>界面</span>
      </button>
      <div className="activity-rail-spacer" />
      <div className="activity-book-progress" aria-label="当前阅读进度 68%"><span>68</span></div>
    </nav>
  );
}

function PrimaryPanel({ state, actions }: { state: SharedPrototypeState; actions: SharedPrototypeActions }) {
  const style = { '--prototype-left-width': `${state.leftWidth}px` } as CSSProperties;
  return (
    <aside className="prototype-primary-panel variant-c-primary" style={style} aria-label="主侧栏">
      {state.activePanel === 'library' ? (
        <LibraryPanel state={state} actions={actions} />
      ) : state.activePanel === 'toc' ? (
        <TocPanel activeBook={findBook(state.folders, state.activeBookId)} />
      ) : (
        <InterfacePanel state={state} actions={actions} />
      )}
    </aside>
  );
}

function LibraryPanel({ state, actions }: { state: SharedPrototypeState; actions: SharedPrototypeActions }) {
  const materialCount = countBooks(state.folders);
  return (
    <div className="library-panel">
      <div className="sidebar-heading">
        <div><span className="sidebar-eyebrow">资源管理器</span><h2>书库</h2></div>
        <div className="sidebar-heading-actions">
          <button type="button" aria-label="新建顶层文件夹" title="新建顶层文件夹" onClick={() => actions.addFolder()}><FolderPlus size={16} aria-hidden /></button>
          <button type="button" aria-label="折叠全部文件夹" title="折叠全部文件夹" onClick={() => actions.showStatus('可在树节点上展开或折叠文件夹')}><PanelLeftClose size={16} aria-hidden /></button>
          <button type="button" aria-label="书库更多操作" title="书库更多操作" onClick={() => actions.showStatus('书库操作已集中到此处')}><MoreHorizontal size={16} aria-hidden /></button>
        </div>
      </div>
      <label className="library-search" htmlFor="prototype-library-search">
        <Search size={14} aria-hidden />
        <input id="prototype-library-search" type="search" value={state.query} onChange={(event) => actions.setQuery(event.target.value)} placeholder="搜索书名或作者" />
        <kbd>⌘ P</kbd>
      </label>
      <div className="library-summary"><span>{materialCount} 本材料</span><span>最多 {MAX_FOLDER_DEPTH} 层文件夹</span></div>
      <LibraryTree state={state} actions={actions} />
    </div>
  );
}

function LibraryTree({ state, actions }: { state: SharedPrototypeState; actions: SharedPrototypeActions }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(collectFolderIds(state.folders)));
  const normalizedQuery = state.query.trim().toLocaleLowerCase('zh-CN');

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderFolder = (item: PrototypeFolder, depth: number): React.ReactNode => {
    if (normalizedQuery && !folderContainsQuery(item, normalizedQuery)) return null;
    const isExpanded = expanded.has(item.id);
    const hasChildren = item.children.length > 0 || item.books.length > 0;
    const visibleBooks = item.books.filter((itemBook) => matchesBook(itemBook, normalizedQuery));
    return (
      <div className="tree-folder" role="treeitem" aria-expanded={isExpanded} key={item.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleDrop(event, item.id, actions)}>
        <div className="tree-folder-row" style={{ paddingLeft: 4 + depth * 6 }}>
          <button type="button" className="tree-folder-toggle" aria-label={`${isExpanded ? '折叠' : '展开'} ${item.name}`} onClick={() => toggle(item.id)}>
            <span className="tree-chevron">{hasChildren ? (isExpanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />) : null}</span>
            <span className="tree-name">{item.name}</span>
            <span className="tree-count">{item.books.length}</span>
          </button>
          <button type="button" className="tree-more" aria-label={`在${item.name}下新建子文件夹`} title={`在${item.name}下新建子文件夹`} onClick={() => actions.addFolder(item.id)}><MoreHorizontal size={15} aria-hidden /></button>
        </div>
        {isExpanded ? (
          <div role="group" className="tree-children">
            {item.children.map((child) => renderFolder(child, depth + 1))}
            {visibleBooks.map((itemBook) => (
              <button type="button" role="treeitem" draggable key={itemBook.id} className={state.activeBookId === itemBook.id ? 'tree-book active' : 'tree-book'} style={{ paddingLeft: 12 + depth * 6 }} onDragStart={(event) => setBookDragData(event, itemBook.id)} onClick={() => actions.selectBook(itemBook.id)} title={`${itemBook.title} · ${itemBook.author}`}>
                <GripVertical size={12} aria-hidden className="drag-grip" />
                <BookMarked size={14} aria-hidden />
                <span>{itemBook.title}</span>
                <small>{itemBook.format}</small>
              </button>
            ))}
            {item.children.length === 0 && visibleBooks.length === 0 ? <div className="empty-folder">文件夹为空</div> : null}
          </div>
        ) : null}
      </div>
    );
  };

  return <div className="library-tree" role="tree" aria-label="书库文件夹树">{state.folders.map((item) => renderFolder(item, 0))}</div>;
}

function TocPanel({ activeBook }: { activeBook: PrototypeBook | undefined }) {
  const [openSections, setOpenSections] = useState(() => new Set(['part-1', 'part-2']));
  const sections = [
    { id: 'preface', title: '序言：阅读的视角', children: [] },
    { id: 'part-1', title: '第一部分 认知革命', children: ['1. 一种无足轻重的动物', '2. 知善恶树', '3. 亚当和夏娃的一天'] },
    { id: 'part-2', title: '第二部分 农业革命', children: ['4. 史上最大骗局', '5. 盖起金字塔', '6. 记忆过载'] },
    { id: 'part-3', title: '第三部分 人类的融合统一', children: ['7. 历史的方向', '8. 金钱的味道'] },
  ];
  return (
    <div className="toc-panel">
      <div className="sidebar-heading"><div><span className="sidebar-eyebrow">当前材料</span><h2>目录</h2></div><button type="button" aria-label="折叠全部目录" title="折叠全部目录"><PanelLeftClose size={16} aria-hidden /></button></div>
      <div className="toc-book-title"><BookOpen size={15} aria-hidden /><span>{activeBook?.title ?? '阅读材料'}</span></div>
      <nav className="toc-tree" aria-label="材料目录">
        {sections.map((section) => {
          const open = openSections.has(section.id);
          return (
            <div key={section.id} className="toc-section">
              <button type="button" className="toc-section-title" aria-expanded={section.children.length > 0 ? open : undefined} onClick={() => {
                if (section.children.length === 0) return;
                setOpenSections((current) => {
                  const next = new Set(current);
                  if (open) next.delete(section.id);
                  else next.add(section.id);
                  return next;
                });
              }}>
                {section.children.length > 0 ? (open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />) : <span className="toc-spacer" />}
                <span>{section.title}</span>
              </button>
              {open ? section.children.map((child, index) => <button type="button" className={index === 1 ? 'toc-child active' : 'toc-child'} key={child}>{child}</button>) : null}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function InterfacePanel({ state, actions }: { state: SharedPrototypeState; actions: SharedPrototypeActions }) {
  const [typographySectionOpen, setTypographySectionOpen] = useState(true);
  const [themeSectionOpen, setThemeSectionOpen] = useState(false);
  const resetReadingSettings = () => {
    actions.setReadingFontFamily('default');
    actions.setReadingFontSize(16);
    actions.setReadingFontWeight(400);
    actions.setReadingLineHeight(1.95);
    actions.setReadingViewMode('double');
    actions.setReadingZoom(100);
    actions.setReadingWidth(680);
    actions.showStatus('已恢复默认阅读排版');
  };

  return (
    <div className="interface-panel">
      <div className="sidebar-heading">
        <div><span className="sidebar-eyebrow">显示与阅读</span><h2>排版</h2></div>
        <button type="button" aria-label="关闭界面面板" title="关闭界面面板" onClick={() => actions.setActivePanel(null)}><X size={16} aria-hidden /></button>
      </div>
      <div className="interface-panel-scroll">
        <div className="interface-scope-tabs" role="tablist" aria-label="排版作用范围">
          <button type="button" role="tab" aria-selected={state.interfaceScope === 'book'} className={state.interfaceScope === 'book' ? 'active' : ''} onClick={() => { actions.setInterfaceScope('book'); actions.showStatus('正在预览当前书籍排版'); }}>书籍</button>
          <button type="button" role="tab" aria-selected={state.interfaceScope === 'global'} className={state.interfaceScope === 'global' ? 'active' : ''} onClick={() => { actions.setInterfaceScope('global'); actions.showStatus('正在预览全局阅读默认'); }}>全局</button>
        </div>

        <div className="interface-divider" />

        <section className="interface-typography-section" aria-labelledby="interface-typography-title">
          <button className="interface-typography-disclosure" type="button" aria-expanded={typographySectionOpen} aria-controls="interface-typography-options" onClick={() => setTypographySectionOpen((open) => !open)}>
            <ChevronDown className={typographySectionOpen ? 'open' : ''} size={17} aria-hidden />
            <strong id="interface-typography-title">排版</strong>
          </button>
          <div id="interface-typography-options" className="interface-typography-options" hidden={!typographySectionOpen}>
            <label className="interface-reference-control">
              <span>视图</span>
              <select aria-label="视图" value={state.readingViewMode} onChange={(event) => actions.setReadingViewMode(event.target.value as ReadingViewMode)}>
                <option value="double">双页</option>
                <option value="single">单页</option>
              </select>
            </label>
            <label className="interface-reference-control">
              <span>字体</span>
              <select aria-label="字体" value={state.readingFontFamily} onChange={(event) => actions.setReadingFontFamily(event.target.value as ReadingFontFamily)}>
                <option value="default">default</option>
                <option value="serif">宋体衬线</option>
                <option value="sans">系统无衬线</option>
              </select>
            </label>
            <ReadingStepperControl label="字号" value={state.readingFontSize} defaultValue={16} min={16} max={22} step={1} format={(value) => `${value}px`} onChange={actions.setReadingFontSize} />
            <ReadingStepperControl label="字重" value={state.readingFontWeight} defaultValue={400} min={300} max={700} step={50} format={(value) => `${value}`} onChange={actions.setReadingFontWeight} />
            <ReadingStepperControl label="行高" value={state.readingLineHeight} defaultValue={1.95} min={1.65} max={2.2} step={0.05} format={(value) => value.toFixed(2)} onChange={actions.setReadingLineHeight} />
            <ReadingStepperControl label="缩放" value={state.readingZoom} defaultValue={100} min={80} max={140} step={10} format={(value) => `${value}%`} onChange={actions.setReadingZoom} />
          </div>
        </section>

        <button type="button" className="interface-reset" onClick={resetReadingSettings}><RotateCcw size={14} aria-hidden />恢复默认阅读排版</button>

        <section className="interface-section interface-theme-section interface-theme-collapsible" aria-labelledby="interface-theme-title">
          <button
            className="interface-section-disclosure"
            type="button"
            aria-expanded={themeSectionOpen}
            aria-controls="interface-theme-options"
            onClick={() => setThemeSectionOpen((open) => !open)}
          >
            <span className="interface-section-disclosure-icon" aria-hidden><Palette size={16} /></span>
            <span className="interface-section-disclosure-copy">
              <span className="interface-section-kicker">工作台外观</span>
              <strong id="interface-theme-title">主题配色</strong>
            </span>
            <span className="interface-section-disclosure-current">{getPrototypeTheme(state.theme).label}</span>
            <ChevronDown className={themeSectionOpen ? 'interface-section-disclosure-chevron open' : 'interface-section-disclosure-chevron'} size={15} aria-hidden />
          </button>
          <div id="interface-theme-options" className="interface-theme-options" hidden={!themeSectionOpen}>
            <ThemeOptionList theme={state.theme} onSelect={(theme) => { actions.setTheme(theme); actions.showStatus(`已切换到${getPrototypeTheme(theme).label}主题`); }} />
            <ThemeGlowToggle glowEnabled={state.glowEnabled} onChange={() => { actions.setGlowEnabled(!state.glowEnabled); actions.showStatus(state.glowEnabled ? '已关闭背景光效果' : '已开启背景光效果'); }} />
          </div>
        </section>
      </div>
    </div>
  );
}

function ReadingStepperControl({ label, value, defaultValue, min, max, step, format, onChange }: { label: string; value: number; defaultValue: number; min: number; max: number; step: number; format: (value: number) => string; onChange: (value: number) => void }) {
  const displayValue = value === defaultValue ? 'default' : format(value);
  const decrement = () => onChange(Math.max(min, Number((value - step).toFixed(2))));
  const increment = () => onChange(Math.min(max, Number((value + step).toFixed(2))));
  return (
    <div className="interface-reference-control interface-stepper-control">
      <span>{label}</span>
      <div className="interface-stepper-field">
        <output aria-label={`${label}当前值`}>{displayValue}</output>
        <button type="button" aria-label={`减小${label}`} title={`减小${label}`} onClick={decrement}><Minus size={17} aria-hidden /></button>
        <button type="button" aria-label={`增大${label}`} title={`增大${label}`} onClick={increment}><Plus size={19} aria-hidden /></button>
        <button type="button" aria-label={`恢复默认${label}`} title={`恢复默认${label}`} onClick={() => onChange(defaultValue)}><X size={19} aria-hidden /></button>
      </div>
    </div>
  );
}

function ReaderCanvas({ state, actions }: { state: SharedPrototypeState; actions: SharedPrototypeActions }) {
  const activeBook = findBook(state.folders, state.activeBookId);
  const [moreOpen, setMoreOpen] = useState(false);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const readingStyle = {
    '--prototype-reading-font-size': `${state.readingFontSize}px`,
    '--prototype-reading-font-weight': state.readingFontWeight,
    '--prototype-reading-line-height': state.readingLineHeight,
    '--prototype-reading-zoom': state.readingZoom / 100,
    '--prototype-reading-width': `${state.readingWidth}px`,
  } as CSSProperties;

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className={`reader-canvas reader-zen reading-font-${state.readingFontFamily}`} data-reading-view-mode={state.readingViewMode} style={readingStyle}>
      <div className="editor-tabs" role="tablist" aria-label="阅读标签">
        <button type="button" role="tab" aria-selected="true" className="editor-tab active"><BookMarked size={14} aria-hidden /><span>{activeBook?.title ?? '阅读材料'}</span><span className="tab-progress-dot" title="主要阅读材料" /><X size={13} aria-hidden /></button>
        <button type="button" role="tab" aria-selected="false" className="editor-tab"><BookMarked size={14} aria-hidden /><span>规训与惩罚</span><X size={13} aria-hidden /></button>
        <div className="editor-tab-spacer" />
        <button type="button" aria-label="拆分编辑器" title="拆分编辑器"><Columns3 size={15} aria-hidden /></button>
      </div>
      <div className="reader-toolbar">
        <div className="reader-location"><span>第二部分</span><ChevronRight size={12} aria-hidden /><strong>记忆、秩序与阅读</strong></div>
        <div className="reader-toolbar-actions">
          <button type="button" aria-label="缩小" title="缩小"><ZoomOut size={15} aria-hidden /></button><span>100%</span><button type="button" aria-label="放大" title="放大"><ZoomIn size={15} aria-hidden /></button><span className="toolbar-separator" /><button type="button" aria-label="添加书签" title="添加书签"><Bookmark size={15} aria-hidden /></button>
          <div className="more-menu-anchor" ref={moreRef}>
            <button type="button" aria-label="更多操作" title="更多操作" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={16} aria-hidden /></button>
            {moreOpen ? <div className="more-menu" role="menu" aria-label="当前书籍更多操作"><button type="button" role="menuitem" onClick={() => { setAnnotationOpen(true); setMoreOpen(false); }}>查看本书批注</button><button type="button" role="menuitem" onClick={() => { actions.showStatus('已准备导出本书批注'); setMoreOpen(false); }}>导出本书批注…</button><div className="menu-separator" role="separator" /><button type="button" role="menuitem" onClick={() => { actions.showStatus('已打开阅读设置'); setMoreOpen(false); }}>阅读设置…</button></div> : null}
          </div>
        </div>
      </div>
      <div className="reading-surface">
        <article>
          <header className="article-header"><span className="article-kicker">阅读札记 · 第 06 章</span><h1>记忆、秩序与阅读</h1><p className="article-deck">工具应该安静地承载思考，而不是成为思考本身。</p></header>
          {ARTICLE_PARAGRAPHS.map((paragraph, index) => (
            <p key={paragraph} className={index === 1 ? 'highlighted-paragraph' : ''}>
              {paragraph}
              {index === 1 ? <button type="button" className="inline-annotation" aria-label="查看这段文字的批注" onClick={() => setAnnotationOpen(true)}>侧栏可以出现，但正文始终应该占据视觉中心。</button> : null}
            </p>
          ))}
          {annotationOpen ? <aside className="annotation-context-card" aria-label="当前标注批注"><header><StickyNote size={14} aria-hidden /><strong>批注</strong><button type="button" aria-label="关闭批注" title="关闭批注" onClick={() => setAnnotationOpen(false)}><X size={14} aria-hidden /></button></header><blockquote>侧栏可以出现，但正文始终应该占据视觉中心。</blockquote><p>这应该成为工作台布局的首要判断标准。</p></aside> : null}
          <blockquote>“整理不是把所有内容同时摆在眼前，而是在需要时能准确地找到它。”</blockquote>
          <p>在这个工作台里，左侧活动栏只保留书库与目录。导入、备份、排版、批注等动作被放回菜单，右侧栏暂时只保留未来的 Agent 交互能力。</p>
        </article>
      </div>
      <div className="reading-footer"><span>{activeBook?.progress ?? 68}%</span><div className="reading-progress-track"><span style={{ width: `${activeBook?.progress ?? 68}%` }} /></div><span>第 126 / 284 页</span></div>
    </div>
  );
}

function AgentPanel({ state, actions }: { state: SharedPrototypeState; actions: SharedPrototypeActions }) {
  const style = { '--prototype-right-width': `${state.rightWidth}px` } as CSSProperties;
  return (
    <aside className="prototype-agent-panel frosted-zone" style={style} aria-label="Agent 侧栏">
      <header className="agent-heading"><div><span className="sidebar-eyebrow">未来能力</span><h2>Agent</h2></div><button type="button" aria-label="关闭 Agent 侧栏" title="关闭 Agent 侧栏" onClick={() => actions.setAgentVisible(false)}><X size={16} aria-hidden /></button></header>
      <div className="agent-empty"><div className="agent-orb" aria-hidden><Sparkles size={22} /></div><strong>Agent 交互预留区</strong><p>当前版本暂不实现 Agent。这里未来可承载对话、任务和阅读辅助能力。</p></div>
    </aside>
  );
}

function ResizeHandle({ label, side, value, min, max, onChange }: { label: string; side: 'left' | 'right'; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startValue = value;
    const move = (pointerEvent: PointerEvent) => {
      const delta = pointerEvent.clientX - startX;
      const nextValue = side === 'left' ? startValue + delta : startValue - delta;
      onChange(Math.max(min, Math.min(max, nextValue)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('prototype-resizing');
    };
    document.body.classList.add('prototype-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };
  return <div className={`prototype-resize-handle ${side}`} role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} tabIndex={0} onPointerDown={startResize} onKeyDown={(event) => { const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0; if (direction === 0) return; event.preventDefault(); onChange(Math.max(min, Math.min(max, value + direction * (side === 'left' ? 12 : -12)))); }} />;
}

function WorkbenchStatus({ state }: { state: SharedPrototypeState }) {
  const activeTheme = getPrototypeTheme(state.theme);
  return <footer className="workbench-statusbar"><div><span className="status-indicator" /><span>AI Reader</span><span>本地托管书库</span></div><div><span>VS Code 工作区</span><span>UTF-8</span><span className="status-theme">{state.theme === 'midnight' ? <Moon size={12} aria-hidden /> : <Sun size={12} aria-hidden />}<span>{activeTheme.label}</span></span></div></footer>;
}

function getPrototypeTheme(theme: ThemeMode): PrototypeTheme {
  return PROTOTYPE_THEMES.find((option) => option.id === theme) ?? PROTOTYPE_THEMES[0]!;
}

function setBookDragData(event: DragEvent<HTMLButtonElement>, bookId: string) {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-ai-reader-book', bookId);
}

function handleDrop(event: React.DragEvent<HTMLDivElement>, folderId: string, actions: SharedPrototypeActions) {
  event.preventDefault();
  const bookId = event.dataTransfer.getData('application/x-ai-reader-book');
  if (bookId) actions.moveBook(bookId, folderId);
}

function findFolder(folders: PrototypeFolder[], id: string): PrototypeFolder | undefined {
  for (const item of folders) {
    if (item.id === id) return item;
    const nested = findFolder(item.children, id);
    if (nested) return nested;
  }
  return undefined;
}

function findBook(folders: PrototypeFolder[], id: string): PrototypeBook | undefined {
  for (const item of folders) {
    const match = item.books.find((candidate) => candidate.id === id);
    if (match) return match;
    const nested = findBook(item.children, id);
    if (nested) return nested;
  }
  return undefined;
}

function collectFolderIds(folders: PrototypeFolder[]): string[] {
  return folders.flatMap((item) => [item.id, ...collectFolderIds(item.children)]);
}

function countBooks(folders: PrototypeFolder[]): number {
  return folders.reduce((total, item) => total + item.books.length + countBooks(item.children), 0);
}

function countFolders(folders: PrototypeFolder[], prefix: string): number {
  return folders.reduce((total, item) => total + (item.name.startsWith(prefix) ? 1 : 0) + countFolders(item.children, prefix), 0);
}

function folderDepth(folders: PrototypeFolder[], id: string, depth = 1): number {
  for (const item of folders) {
    if (item.id === id) return depth;
    const nested = folderDepth(item.children, id, depth + 1);
    if (nested > 0) return nested;
  }
  return 0;
}

function appendChild(folders: PrototypeFolder[], parentId: string, child: PrototypeFolder): PrototypeFolder[] {
  return folders.map((item) => item.id === parentId ? { ...item, children: [...item.children, child] } : { ...item, children: appendChild(item.children, parentId, child) });
}

function removeBook(folders: PrototypeFolder[], bookId: string): { folders: PrototypeFolder[]; book: PrototypeBook | undefined } {
  let removed: PrototypeBook | undefined;
  const next = folders.map((item) => {
    const direct = item.books.find((candidate) => candidate.id === bookId);
    if (direct) removed = direct;
    const nested = removeBook(item.children, bookId);
    if (!removed && nested.book) removed = nested.book;
    return { ...item, books: item.books.filter((candidate) => candidate.id !== bookId), children: nested.folders };
  });
  return { folders: next, book: removed };
}

function appendBook(folders: PrototypeFolder[], folderId: string, itemBook: PrototypeBook): PrototypeFolder[] {
  return folders.map((item) => item.id === folderId ? { ...item, books: [...item.books, itemBook] } : { ...item, children: appendBook(item.children, folderId, itemBook) });
}

function matchesBook(itemBook: PrototypeBook, query: string): boolean {
  return !query || `${itemBook.title} ${itemBook.author}`.toLocaleLowerCase('zh-CN').includes(query);
}

function folderContainsQuery(item: PrototypeFolder, query: string): boolean {
  return item.name.toLocaleLowerCase('zh-CN').includes(query) || item.books.some((itemBook) => matchesBook(itemBook, query)) || item.children.some((child) => folderContainsQuery(child, query));
}
