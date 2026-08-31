import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { ExternalUrlOpener } from '../app/externalUrlOpener';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import type { BookDocument } from '../domain/reader/bookDocument';
import { EpubBookDocument } from '../domain/reader/epubBookDocument';
import {
  createEpubDerivedCache,
  type EpubDerivedCache,
} from '../domain/reader/epubCanonical';
import {
  createCanonicalSearchIndexCache,
  type CanonicalSearchIndexCache,
} from '../domain/reader/canonicalSearch';
import {
  createEpubDerivedTocCache,
  type EpubDerivedTocCache,
} from '../domain/reader/derivedToc';
import type { EpubNativeAccelerator } from '../domain/reader/nativeEpub';
import {
  createFoliateViewHostFactory,
  type FoliateViewHostFactory,
} from '../domain/reader/foliateViewHost';
import { back as historyBack, forward as historyForward } from '../domain/reader/navigationHistory';
import type { PdfFitMode } from '../domain/reader/readingLocation';
import { PdfBookDocument } from '../domain/reader/pdf/pdfBookDocument';
import type { PdfFileSource, PdfJsLib } from '../domain/reader/pdf/pdfLibrary';
import type { PdfPageRasterizer } from '../domain/reader/pdf/pdfPageRenderer';
import { isPdfTextAnchor, decodePdfTextAnchor } from '../domain/reader/pdf/pdfTextAnchor';
import { MarkdownBookDocument } from '../domain/reader/markdown/markdownBookDocument';
import type { ReadingTypography } from '../domain/reader/typography';
import { resolveTypography } from '../domain/reader/typography';
import { inspectEpub } from '../domain/library/epub/epubInspector';
import type { ImportRepository } from '../domain/library/importRepository';
import type { ReadingMaterial } from '../domain/library/material';
import { formatFromSourceFileName, type MaterialFormat } from '../domain/library/materialFormat';
import type { ReadingLocation } from '../domain/reader/readingLocation';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { cancelAllSearches, cancelSearch, clearSearch, runSearch } from './searchRunner';
import { useSearchStore } from './searchStore';
import { ThrottledPositionPersister } from './positionPersister';
import { loadAnnotationsForView } from './annotationCommands';
import { useMarkdownSessionStore } from './markdownSessionStore';
import { useAnnotationStore } from './annotationStore';
import { useLibraryStore } from './libraryStore';
import { useReaderRuntime, type ReaderDocumentStatus } from './readerRuntime';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';
import { readManagedMarkdownText } from './markdownSource';
import { serializeWorkspaceState } from './workbenchCommands';
import {
  buildReaderRuntimeCacheKeyForMaterial,
  estimateReaderRuntimeResourceUsage,
  ReaderRuntimeCache,
} from './readerRuntimeCache';
import {
  findView,
  findViewByMaterialId,
  findViewGroupId,
  findViewInGroupByMaterialId,
  getActiveViewId,
  isViewActive,
} from './viewUtils';

export interface ReaderCommandDependencies {
  importRepository: ImportRepository;
  workspaceRepository: WorkspaceRepository;
  annotationRepository?: AnnotationRepository;
  viewHostFactory?: FoliateViewHostFactory;
  externalUrlOpener?: ExternalUrlOpener;
  /** 可注入的 PDF.js 库(测试用);缺省懒加载真实引擎。 */
  pdfLib?: PdfJsLib | undefined;
  /** 可注入的页面光栅化函数(测试用)。 */
  pdfRasterize?: PdfPageRasterizer | undefined;
  /** 可选的 EPUB 原生机械预取;未通过 parity 或失败时返回 null。 */
  epubNativeAccelerator?: EpubNativeAccelerator | undefined;
  /** 可选的 EPUB 规范转换缓存;生产默认在当前进程内按版本共享。 */
  epubDerivedCache?: EpubDerivedCache<string>;
  /** 可选的可重建全文搜索索引缓存;按书籍/规范/查询版本隔离。 */
  canonicalSearchIndexCache?: CanonicalSearchIndexCache;
  /** 可选的 EPUB 推导目录缓存;生产由 Rust 私有文件 Repository 提供，不参与同步。 */
  epubDerivedTocCache?: EpubDerivedTocCache;
  /** 阅读视图的有限活 Runtime 缓存；未注入时按当前窗口自动选择桌面/平板预算。 */
  readerRuntimeCache?: ReaderRuntimeCache;
}

/**
 * 阅读位置持久化器注册表(活对象,不进入持久化状态)。
 * 每个打开中的阅读视图对应一个节流写入器,关闭时强制 flush。
 */
const persisters = new Map<string, ThrottledPositionPersister>();

interface ActiveViewMount {
  document: BookDocument;
  container: HTMLElement;
  persister: ThrottledPositionPersister;
  restoring: boolean;
  restoringLocation: string | null;
  restoreGeneration: number;
  disposed: boolean;
  dispose: () => void;
}

const activeMounts = new Map<string, ActiveViewMount>();
const runtimeInputCleanups = new Map<string, () => void>();
const defaultEpubDerivedCache = createEpubDerivedCache<string>();
const defaultCanonicalSearchIndexCache = createCanonicalSearchIndexCache();
const defaultEpubDerivedTocCache = createEpubDerivedTocCache();

function isCurrentViewMount(viewId: string, document: BookDocument): boolean {
  const mount = activeMounts.get(viewId);
  return mount?.document === document && !mount.disposed;
}

function describeDocumentOpenError(error: unknown): string {
  const rawMessage =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  if (/托管书库|托管副本|managed file|managed.*missing/i.test(rawMessage)) {
    return '正文当前不可用：托管副本已丢失。请重新导入相同内容的文件以重新关联；内容不同的文件请使用版本迁移。';
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return '阅读器初始化失败，请重新打开该材料。';
}

function reportReaderNavigationFailure(viewId: string, error: unknown): void {
  const view = findView(viewId);
  const message = describeDocumentOpenError(error);
  useShellUiStore.getState().setStatusMessage(`阅读翻页失败：${message}`);
  console.error('阅读翻页失败', {
    viewId,
    materialId: view?.materialId ?? null,
    error,
  });
}

function reportReaderReadFailure(viewId: string, error: unknown): void {
  const view = findView(viewId);
  useShellUiStore.getState().setStatusMessage(`阅读内容读取失败：${describeDocumentOpenError(error)}`);
  console.error('阅读内容读取失败', {
    viewId,
    materialId: view?.materialId ?? null,
    error,
  });
}

interface ViewMountReadiness {
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
}

const viewMountReadiness = new Map<string, ViewMountReadiness>();

function getViewMountReadiness(viewId: string): ViewMountReadiness {
  const existing = viewMountReadiness.get(viewId);
  if (existing) return existing;

  return createViewMountReadiness(viewId);
}

function createViewMountReadiness(viewId: string): ViewMountReadiness {

  let resolvePromise!: () => void;
  const readiness: ViewMountReadiness = {
    promise: new Promise<void>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: () => {
      if (readiness.settled) return;
      readiness.settled = true;
      resolvePromise();
    },
    settled: false,
  };
  viewMountReadiness.set(viewId, readiness);
  return readiness;
}

function prepareViewMountReadiness(viewId: string): ViewMountReadiness {
  const existing = viewMountReadiness.get(viewId);
  if (existing && !existing.settled) return existing;
  return createViewMountReadiness(viewId);
}

async function waitForViewMount(viewId: string): Promise<void> {
  const readiness = getViewMountReadiness(viewId);
  if (readiness.settled) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    void readiness.promise.then(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/** 等待 Foliate 在 attach/goTo 后可能排队的 relocate 事件全部落地。 */
async function waitForReaderRestoreSettling(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** 缓存回切的点 CFI 依赖 iframe/布局先完成一个绘制周期。 */
async function waitForReaderRestoreBeforeNavigation(location: ReadingLocation): Promise<void> {
  const cfi = location.kind === 'epub' || location.kind === 'markdown' ? location.cfi : null;
  if (
    cfi === null ||
    (cfi.includes(',') && !cfi.includes(',,'))
  ) {
    return;
  }
  const frameCount = cfi.includes(',,/2') ? 2 : 1;
  if (typeof requestAnimationFrame === 'function') {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return;
  }
  for (let frame = 0; frame < frameCount; frame += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** attach 可能先让 Foliate 回报章节起点;必要时在该事件完成后再校正一次。 */
async function restoreAttachedReaderLocation(
  document: BookDocument,
  location: ReadingLocation,
): Promise<void> {
  // attach() 只是把 Foliate renderer 移回可见容器; Chromium/WebView 需要至少
  // 一个绘制周期才能恢复 iframe 文档与布局。过早执行 CFI anchor 会让
  // foliate-js 在未准备好的节点上解构 nodeType,并使回切停在空白阅读区。
  await waitForReaderRestoreBeforeNavigation(location);
  await document.goToLocation(location);
  await waitForReaderRestoreSettling();
}

function serializeReadingLocation(location: ReadingLocation): string {
  return JSON.stringify(location);
}

function isPdfAtRestoredLocation(document: BookDocument, location: ReadingLocation): boolean {
  const current = document.getLocation();
  return (
    document.format !== 'pdf' ||
    (current !== null && serializeReadingLocation(current) === serializeReadingLocation(location))
  );
}

/** 同一阅读视图尚在打开时,复用进行中的文档创建任务,避免快速重复点击触发并发读取。 */
const pendingDocumentCreations = new Map<string, Promise<BookDocument | null>>();

/** 用于让应用关闭时，尚未完成的惰性恢复不会重新把文档放回 Runtime。 */
let runtimeGeneration = 0;

/** 串行化标签激活/关闭/打开，避免异步 flush 与文档创建互相覆盖最新用户意图。 */
let runtimeTransitionQueue: Promise<void> = Promise.resolve();

/** 当前应用唯一的 Runtime 缓存；仅由 Reader Command 触碰，不进入 Zustand。 */
let registeredReaderRuntimeCache: ReaderRuntimeCache | null = null;

/** 真实浏览器测量读取当前 Command 所拥有的 Runtime；不返回任何持久化数据。 */
export function getReaderRuntimeDocumentForMeasurement(viewId: string): BookDocument | undefined {
  return useReaderRuntime.getState().getDocument(viewId);
}

export function getReaderRuntimeStatusForMeasurement(viewId: string): ReaderDocumentStatus | undefined {
  return useReaderRuntime.getState().documentStates.get(viewId);
}

/** ReadingView 注册输入接线清理；挂起/关闭时由 Runtime 所有者同步调用。 */
export function registerReaderRuntimeInputCleanup(
  viewId: string,
  cleanup: () => void,
): () => void {
  runtimeInputCleanups.get(viewId)?.();
  runtimeInputCleanups.set(viewId, cleanup);
  return () => {
    if (runtimeInputCleanups.get(viewId) !== cleanup) return;
    runtimeInputCleanups.delete(viewId);
    cleanup();
  };
}

function clearReaderRuntimeInput(viewId: string): void {
  const cleanup = runtimeInputCleanups.get(viewId);
  runtimeInputCleanups.delete(viewId);
  cleanup?.();
}

function getReaderRuntimeCache(dependencies: ReaderCommandDependencies): ReaderRuntimeCache {
  if (dependencies.readerRuntimeCache) return dependencies.readerRuntimeCache;
  if (registeredReaderRuntimeCache) return registeredReaderRuntimeCache;
  registeredReaderRuntimeCache = new ReaderRuntimeCache();
  return registeredReaderRuntimeCache;
}

/** 在不改变 Workspace 活动视图的前提下挂起一个 ReadingView Runtime。 */
export function suspendReaderViewRuntime(
  dependencies: ReaderCommandDependencies,
  viewId: string,
): Promise<void> {
  return enqueueRuntimeTransition(() => suspendViewRuntime(dependencies, viewId));
}

/** 恢复一个当前活动视图的 Runtime;命中时复用原 BookDocument,否则安全重建。 */
export function restoreReaderViewRuntime(
  dependencies: ReaderCommandDependencies,
  viewId: string,
): Promise<BookDocument | null> {
  return enqueueRuntimeTransition(() => ensureActiveViewDocument(dependencies, viewId));
}

/** 关闭一个不再可缓存的 Runtime,先移除缓存索引再由 Runtime Store 统一 close。 */
function closeReaderRuntime(viewId: string, cache: ReaderRuntimeCache): void {
  cache.remove(viewId);
  useReaderRuntime.getState().removeDocument(viewId);
}

function enqueueRuntimeTransition<T>(operation: () => Promise<T>): Promise<T> {
  const next = runtimeTransitionQueue.then(operation);
  runtimeTransitionQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * 每个阅读视图的"本次导航意图"。普通翻页/滚动用 `replace`;显式跳转用 `push`。
 * 它决定下一次 relocate 时当前历史节点是被替换还是新增。
 * 这是活对象,不进入持久化状态。
 */
const navigationIntents = new Map<string, 'replace' | 'push'>();

/**
 * 读取并检查托管 EPUB 字节,构造 BookDocument。
 * 返回 null 表示材料不是可读的 EPUB。
 */
async function createEpubDocument(
  dependencies: ReaderCommandDependencies,
  material: ReadingMaterial,
): Promise<BookDocument | null> {
  let source: Blob;
  try {
    source = await dependencies.importRepository.openManagedFileSource(material.id);
  } catch (error) {
    throw new Error(`读取 EPUB 失败：${describeDocumentOpenError(error)}`);
  }
  let metadata;
  try {
    const result = await inspectEpub(source);
    metadata = result.metadata;
  } catch (error) {
    throw new Error(`解析 EPUB 失败：${describeDocumentOpenError(error)}`);
  }
  let nativePrefetch = null;
  if (dependencies.epubNativeAccelerator) {
    try {
      nativePrefetch = await dependencies.epubNativeAccelerator.prefetch(material.id);
    } catch (error) {
      // 加速器是可选旁路,不能把原生桥接故障升级成用户无法阅读。
      console.warn('EPUB 原生预取失败,已回退到纯 JavaScript', error);
    }
  }
  return new EpubBookDocument({
    source,
    metadata,
    viewHostFactory: dependencies.viewHostFactory ?? createFoliateViewHostFactory(),
    nativePrefetch,
    sourceFingerprint: material.fingerprint,
    derivedCache: dependencies.epubDerivedCache ?? defaultEpubDerivedCache,
    searchIndexCache: dependencies.canonicalSearchIndexCache ?? defaultCanonicalSearchIndexCache,
    derivedTocCache: dependencies.epubDerivedTocCache ?? defaultEpubDerivedTocCache,
  });
}

/**
 * 从已导入材料构造 PDF BookDocument。
 *
 * PDF 的格式检查、来源元数据和首页来源封面在导入阶段完成。阅读阶段只
 * 复用书库中的有效元数据并把同一份 ManagedFileSource 交给 BookDocument,
 * 由挂载阶段创建唯一的 PDF.js 文档。
 */
async function createPdfDocument(
  dependencies: ReaderCommandDependencies,
  material: ReadingMaterial,
): Promise<BookDocument | null> {
  let source: PdfFileSource;
  try {
    source = await dependencies.importRepository.openManagedFileSource(material.id);
  } catch (error) {
    throw new Error(`读取 PDF 失败：${describeDocumentOpenError(error)}`);
  }
  return new PdfBookDocument({
    source,
    metadata: {
      title: material.title,
      author: material.author,
      language: material.language,
    },
    pdfLib: dependencies.pdfLib,
    rasterize: dependencies.pdfRasterize,
  });
}

/**
 * 读取托管 Markdown 字节,构造 BookDocument。
 * 元数据直接取自材料来源快照(导入时已做标题/作者提取与文件名兜底),
 * 避免在读取时重复解析;`MarkdownBookDocument` 构造器内部完成渲染与清洗。
 * 返回 null 表示读取失败。
 */
async function createMarkdownDocument(
  dependencies: ReaderCommandDependencies,
  material: ReadingMaterial,
  options: { preferManagedSource?: boolean } = {},
): Promise<BookDocument | null> {
  const session = useMarkdownSessionStore.getState().getSession(material.id);
  const canReuseSession =
    session?.savedVersion === material.documentVersion &&
    (!options.preferManagedSource || session.dirty);
  const text = canReuseSession
    ? session.text
    : await loadFormalMarkdownSession(dependencies, material);
  return new MarkdownBookDocument({
    text,
    metadata: {
      title: material.title,
      author: material.author,
      language: material.language,
    },
    viewHostFactory: dependencies.viewHostFactory ?? createFoliateViewHostFactory(),
    sourceFingerprint: material.fingerprint,
    searchIndexCache: dependencies.canonicalSearchIndexCache ?? defaultCanonicalSearchIndexCache,
  });
}

/** 读取当前正式 Markdown 并校准共享会话;缓存和源码模式都复用这一入口。 */
async function loadFormalMarkdownSession(
  dependencies: ReaderCommandDependencies,
  material: ReadingMaterial,
): Promise<string> {
  let text: string;
  try {
    text = await readManagedMarkdownText(dependencies.importRepository, material.id);
  } catch (error) {
    throw new Error(`读取 Markdown 失败：${describeDocumentOpenError(error)}`);
  }
  useMarkdownSessionStore
    .getState()
    .replaceFormalText(material.id, text, material.documentVersion);
  return text;
}

/** 源码模式也需要初始化共享会话,但不应因此创建隐藏的 Foliate Runtime。 */
async function ensureMarkdownSession(
  dependencies: ReaderCommandDependencies,
  material: ReadingMaterial,
): Promise<void> {
  const session = useMarkdownSessionStore.getState().getSession(material.id);
  if (session?.savedVersion === material.documentVersion) return;
  await loadFormalMarkdownSession(dependencies, material);
}

/** 按材料格式分派创建对应 BookDocument;未知格式返回 null。 */
async function createDocumentForMaterial(
  dependencies: ReaderCommandDependencies,
  material: ReadingMaterial,
  options: { preferManagedMarkdownSource?: boolean } = {},
): Promise<BookDocument | null> {
  const format = formatFromSourceFileName(material.sourceFileName);
  switch (format) {
    case 'pdf':
      return createPdfDocument(dependencies, material);
    case 'epub':
      return createEpubDocument(dependencies, material);
    case 'markdown':
      return createMarkdownDocument(
        dependencies,
        material,
        options.preferManagedMarkdownSource === undefined
          ? {}
          : { preferManagedSource: options.preferManagedMarkdownSource },
      );
    default:
      return null;
  }
}

function getOrCreatePendingDocument(
  dependencies: ReaderCommandDependencies,
  viewId: string,
  material: ReadingMaterial,
  options: { preferManagedMarkdownSource?: boolean } = {},
): Promise<BookDocument | null> {
  const pending = pendingDocumentCreations.get(viewId);
  if (pending) return pending;

  const creation = createDocumentForMaterial(dependencies, material, options);
  pendingDocumentCreations.set(viewId, creation);
  void creation.then(
    () => {
      if (pendingDocumentCreations.get(viewId) === creation) {
        pendingDocumentCreations.delete(viewId);
      }
    },
    () => {
      if (pendingDocumentCreations.get(viewId) === creation) {
        pendingDocumentCreations.delete(viewId);
      }
    },
  );
  return creation;
}

/**
 * 释放失活标签的界面接线，但把已完成的 EPUB/Markdown Runtime 放入有限缓存。
 * 位置先 flush；搜索、输入焦点和临时覆盖层必须在挂起前清理，防止隐藏 Runtime
 * 继续响应用户输入。PDF 摘下窗口后只保留 PDF.js 文档与当前页的预算内结果。
 */
async function suspendViewRuntime(
  dependencies: ReaderCommandDependencies,
  viewId: string,
): Promise<void> {
  // flush 失败时保留当前 Runtime 和接线，阻止切换覆盖最后位置。
  const locationAtSuspendStart = useReaderRuntime.getState().getDocument(viewId)?.getLocation();
  await flushAndClearViewRuntimeBindings(viewId, dependencies, { preservePdfSearch: true });

  // Foliate 的迟到 relocate 可能在 persister flush 前把 Workspace 写成章节
  // 起点;切换事务以挂起瞬间 BookDocument 的位置为准再写一次,确保回切恢复
  // 的是用户刚刚看到的精确范围而不是重排中间态。
  if (locationAtSuspendStart) {
    useWorkspaceStore.getState().setViewLocation(viewId, locationAtSuspendStart);
    try {
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
    } catch (error) {
      throw error;
    }
  }

  const document = useReaderRuntime.getState().getDocument(viewId);
  if (!document) {
    return;
  }
  const view = findView(viewId);
  const libraryMaterial = view
    ? useLibraryStore.getState().materials.find((candidate) => candidate.id === view.materialId)
    : undefined;
  // 书库 Store 在启动恢复或测试的最小 Command harness 中可能尚未刷新；只读
  // listMaterials 只读取材料元数据，不会打开正文，仍然能判断该材料是否已移入回收站。
  let material = libraryMaterial;
  if (!material && view) {
    try {
      material = (await dependencies.importRepository.listMaterials()).find(
        (candidate) => candidate.id === view.materialId,
      );
    } catch {
      material = undefined;
    }
  }
  const cacheKey =
    useReaderRuntime.getState().getDocumentCacheKey(viewId) ??
    (material ? buildReaderRuntimeCacheKeyForMaterial(viewId, material) : undefined);
  const format = document.format;
  const cache = getReaderRuntimeCache(dependencies);
  const canSuspend = Boolean(
    material &&
      cacheKey &&
      typeof document.attach === 'function' &&
      typeof document.detach === 'function' &&
      document.isRuntimeReady?.() !== false,
  );
  if (!canSuspend) {
    // 没有当前活跃材料、未完成打开、或宿主不支持无损摘下时不能进入缓存。
    closeReaderRuntime(viewId, cache);
    return;
  }

  let result: ReturnType<ReaderRuntimeCache['suspend']>;
  try {
    // 先让格式实现主动收缩页面/范围资源，再按收缩后的快照执行缓存准入；
    // 这样 PDF 不会因为活动窗口的多页 Canvas 被错误判定为超出挂起预算。
    await document.detach!();
    result = cache.suspend({
      viewId,
      materialId: material!.id,
      format,
      key: cacheKey!,
      document,
      usage: estimateReaderRuntimeResourceUsage(document),
    });
  } catch (error) {
    console.warn('读取 Runtime 缓存资源失败,已关闭并将在下次激活时重建', error);
    closeReaderRuntime(viewId, cache);
    return;
  }

  if (result.admitted) {
    try {
      useReaderRuntime.getState().setDocumentLifecycle(viewId, 'suspended');
    } catch (error) {
      // attach/detach 是可选宿主能力;若挂起时宿主拒绝摘下,安全关闭并让
      // 下一次激活走完整重建,不能留下“缓存命中但 DOM 已断开”的假对象。
      console.warn('挂起阅读 Runtime 失败,已关闭并将在下次激活时重建', error);
      closeReaderRuntime(viewId, cache);
    }
  } else {
    // 未完成加载、超出硬预算或未知材料均回到确定性的关闭路径。
    closeReaderRuntime(viewId, cache);
  }
  for (const evicted of result.evicted) {
    closeReaderRuntime(evicted.viewId, cache);
  }
}

/** 关闭并移除视图 Runtime；用于关闭标签、内容版本变化和应用退出。 */
async function disposeViewRuntime(
  dependencies: ReaderCommandDependencies,
  viewId: string,
): Promise<void> {
  await flushAndClearViewRuntimeBindings(viewId, dependencies);
  registeredReaderRuntimeCache?.remove(viewId);
  useReaderRuntime.getState().removeDocument(viewId);
}

/** 清理一个视图的界面接线与临时状态；调用方随后决定挂起还是关闭对象。 */
async function flushAndClearViewRuntimeBindings(
  viewId: string,
  dependencies?: ReaderCommandDependencies,
  options: { preservePdfSearch?: boolean } = {},
): Promise<void> {
  const activeMount = activeMounts.get(viewId);
  const persister = persisters.get(viewId);
  if (persister) {
    await persister.dispose();
    persisters.delete(viewId);
  } else if (dependencies) {
    // 组件挂载接线尚未完成或已被 StrictMode 重建时,仍以 BookDocument 的
    // 最新可序列化位置兜底落盘,避免切换把当前位置退回到旧 Workspace 值。
    const location = useReaderRuntime.getState().getDocument(viewId)?.getLocation();
    if (location) {
      useWorkspaceStore.getState().setViewLocation(viewId, location);
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
    }
  }
  activeMount?.container.querySelector<HTMLElement>(':focus')?.blur();
  clearReaderRuntimeInput(viewId);
  activeMount?.dispose();
  activeMounts.delete(viewId);
  navigationIntents.delete(viewId);
  viewMountReadiness.get(viewId)?.resolve();
  viewMountReadiness.delete(viewId);
  const document = useReaderRuntime.getState().getDocument(viewId);
  if (options.preservePdfSearch && document?.format === 'pdf') {
    // PDF Runtime 缓存保留搜索高亮的绘制结果；只取消异步搜索任务，避免挂起
    // 期间继续产生页面读取，同时不清空可随 renderer 一起恢复的结果。
    cancelSearch(viewId);
  } else {
    clearSearch(viewId);
  }
  useSearchStore.getState().close(viewId);
}

/**
 * 使某材料的所有 Reader Runtime 失效。
 *
 * 该入口供永久清理、Markdown 正式保存和版本迁移调用；它同时清掉挂起缓存与
 * 未被缓存的 PDF 活对象，避免旧完整指纹/文档版本继续存活在进程中。
 */
export interface ReaderRuntimeInvalidationOptions {
  /** false 时只清除挂起对象,保留当前活动阅读视图继续显示可逆的旧正文。 */
  includeActive?: boolean;
}

export async function invalidateReaderRuntimeMaterial(
  materialId: string,
  options: ReaderRuntimeInvalidationOptions = {},
): Promise<void> {
  const includeActive = options.includeActive ?? true;
  const invalidated =
    registeredReaderRuntimeCache?.invalidateMaterial(materialId, { includeActive }) ?? [];
  const invalidatedIds = new Set(invalidated.map((entry) => entry.viewId));
  for (const viewId of useReaderRuntime.getState().documents.keys()) {
    if (
      findView(viewId)?.materialId === materialId &&
      (includeActive || useReaderRuntime.getState().getDocumentLifecycle(viewId) === 'suspended')
    ) {
      invalidatedIds.add(viewId);
    }
  }
  for (const viewId of invalidatedIds) {
    await flushAndClearViewRuntimeBindings(viewId);
    useReaderRuntime.getState().removeDocument(viewId);
  }
}

/** 重新关联或恢复正文后,重建当前材料的活动阅读视图;浏览器降级不依赖整页刷新。 */
export function reloadMaterialViews(
  dependencies: ReaderCommandDependencies,
  materialId: string,
): Promise<void> {
  return enqueueRuntimeTransition(async () => {
    const material = useLibraryStore.getState().materials.find((item) => item.id === materialId);
    if (!material) return;
    const viewIds = useWorkspaceStore
      .getState()
      .editorGroups.flatMap((group) => group.views)
      .filter(
        (view) =>
          view.materialId === materialId &&
          isViewActive(view.id) &&
          !view.sourceMode,
      )
      .map((view) => view.id);
    await invalidateReaderRuntimeMaterial(materialId);
    for (const viewId of viewIds) {
      await ensureActiveViewDocument(dependencies, viewId, material);
    }
  });
}

async function ensureActiveViewDocument(
  dependencies: ReaderCommandDependencies,
  viewId: string,
  material?: ReadingMaterial,
  options: { preferManagedMarkdownSource?: boolean } = {},
): Promise<BookDocument | null> {
  const runtime = useReaderRuntime.getState();
  const existing = runtime.getDocument(viewId);

  runtime.setDocumentState(viewId, { status: 'loading' });

  const view = findView(viewId);
  if (!view || !isViewActive(viewId)) {
    runtime.setDocumentState(viewId, {
      status: 'error',
      message: '阅读视图已失效，请重新打开材料。',
    });
    return null;
  }

  const targetMaterial =
    material ??
    (await dependencies.importRepository.listMaterials()).find(
      (candidate) => candidate.id === view.materialId,
    );
  if (!targetMaterial) {
    runtime.setDocumentState(viewId, {
      status: 'error',
      message: '找不到该阅读材料的托管文件。',
    });
    return null;
  }
  if (targetMaterial.managedFileAvailable === false) {
    runtime.setDocumentState(viewId, {
      status: 'error',
      message:
        '正文当前不可用：托管副本已丢失。请重新导入相同内容的文件以重新关联；内容不同的文件请使用版本迁移。',
    });
    return null;
  }

  // 源码模式由 CodeMirror 独占当前 ReadingView 的可见内容;不要在启动恢复、
  // 标签切换或其它材料刷新时为隐藏的 Foliate Runtime 重新创建正文。
  if (view.sourceMode) {
    if (formatFromSourceFileName(targetMaterial.sourceFileName) === 'markdown') {
      try {
        await ensureMarkdownSession(dependencies, targetMaterial);
      } catch (error) {
        runtime.setDocumentState(viewId, {
          status: 'error',
          message: describeDocumentOpenError(error),
        });
        return null;
      }
    }
    runtime.setDocumentState(viewId, { status: 'idle' });
    return null;
  }

  const cache = getReaderRuntimeCache(dependencies);
  const cacheKey = buildReaderRuntimeCacheKeyForMaterial(viewId, targetMaterial);
  if (existing && runtime.getDocumentLifecycle(viewId) === 'active') {
    if (runtime.getDocumentCacheKey(viewId) === cacheKey) {
      cache.registerActive({
        viewId,
        materialId: targetMaterial.id,
        format: existing.format,
        key: cacheKey,
        document: existing,
        usage: estimateReaderRuntimeResourceUsage(existing),
      });
      runtime.setDocumentState(viewId, { status: 'ready' });
      return existing;
    }
    // 活动对象也必须有可验证的当前版本键；没有证明就关闭后重建。
    await flushAndClearViewRuntimeBindings(viewId, dependencies);
    cache.remove(viewId);
    runtime.removeDocument(viewId);
  } else if (existing) {
    const lookup = cache.activate(viewId, cacheKey);
    if (lookup.kind === 'hit' && lookup.entry.document === existing) {
      runtime.setDocumentLifecycle(viewId, 'active');
      runtime.setDocumentState(viewId, { status: 'ready' });
      return existing;
    }
    // 键不一致或缓存已淘汰时不能猜测复用；移除旧对象并安全重建。
    runtime.removeDocument(viewId);
  }

  const generation = runtimeGeneration;
  let document: BookDocument | null;
  try {
    document = await getOrCreatePendingDocument(dependencies, viewId, targetMaterial, options);
  } catch (error) {
    runtime.setDocumentState(viewId, {
      status: 'error',
      message: describeDocumentOpenError(error),
    });
    console.error('打开阅读文档失败', {
      viewId,
      materialId: targetMaterial.id,
      format: formatFromSourceFileName(targetMaterial.sourceFileName),
      error,
    });
    return null;
  }
  if (!document) {
    runtime.setDocumentState(viewId, {
      status: 'error',
      message: '暂不支持打开该材料格式。',
    });
    return null;
  }
  // A tab may have been switched away while the file was being inspected.
  // Do not leave a renderer behind for an inactive or closed view.
  if (generation !== runtimeGeneration || !isViewActive(viewId) || !findView(viewId)) {
    document.close();
    return null;
  }

  const current = useReaderRuntime.getState().getDocument(viewId);
  if (current) {
    if (current !== document) document.close();
    return current;
  }
  useReaderRuntime.getState().setDocument(viewId, document, {
    lifecycle: 'active',
    cacheKey,
  });
  cache.registerActive({
    viewId,
    materialId: targetMaterial.id,
    format: document.format,
    key: cacheKey,
    document,
    usage: estimateReaderRuntimeResourceUsage(document),
  });
  return document;
}

async function activateViewRuntime(
  dependencies: ReaderCommandDependencies,
  viewId: string,
  material?: ReadingMaterial,
  previousViewIdOverride?: string | null,
  options: { preferManagedMarkdownSource?: boolean } = {},
): Promise<BookDocument | null> {
  const view = findView(viewId);
  const groupId = findViewGroupId(viewId);
  if (!view || !groupId) return null;

  const previousViewId =
    previousViewIdOverride === undefined ? getActiveViewId(groupId) : previousViewIdOverride;
  if (previousViewId && previousViewId !== viewId) {
    const targetIsSourceMode = view.sourceMode;
    const targetDocument = useReaderRuntime.getState().getDocument(viewId);
    const targetCache = getReaderRuntimeCache(dependencies);
    const targetCacheKey =
      (material
        ? buildReaderRuntimeCacheKeyForMaterial(viewId, material)
        : useReaderRuntime.getState().getDocumentCacheKey(viewId)) ??
      targetCache.getEntries().find((entry) => entry.viewId === viewId)?.key;

    // 源码模式不需要可见 Foliate，但未修改内容仍可以保留一个受保护的
    // suspended Runtime。先提升目标缓存项，再挂起上一个活动视图，避免
    // 单槽位 LRU 把源码视图的无损回切对象淘汰。
    if (
      targetIsSourceMode &&
      targetDocument &&
      useReaderRuntime.getState().getDocumentLifecycle(viewId) === 'suspended' &&
      targetCacheKey
    ) {
      const lookup = targetCache.activate(viewId, targetCacheKey);
      if (lookup.kind === 'hit' && lookup.entry.document === targetDocument) {
        useReaderRuntime.getState().setDocumentLifecycle(viewId, 'active');
      } else {
        useReaderRuntime.getState().removeDocument(viewId);
      }
    }

    if (targetIsSourceMode) {
      await suspendViewRuntime(dependencies, previousViewId);
      useWorkspaceStore.getState().setActiveView(groupId, viewId);
      if (useReaderRuntime.getState().getDocument(viewId)) {
        await suspendViewRuntime(dependencies, viewId);
      }
      return null;
    }

    // 先提升目标缓存项再挂起旧活动项。缓存只有一个挂起槽位时，若反过来处理，
    // 旧项会把即将回切的目标 LRU 淘汰，A→B→A 会错误地退化为重建。
    if (
      targetDocument &&
      useReaderRuntime.getState().getDocumentLifecycle(viewId) === 'suspended' &&
      targetCacheKey
    ) {
      const lookup = targetCache.activate(viewId, targetCacheKey);
      if (lookup.kind === 'hit' && lookup.entry.document === targetDocument) {
        const cachedLocation = targetDocument.getLocation();
        const workspaceLocation = findView(viewId)?.location ?? null;
        const locationToRestore =
          targetDocument.format === 'pdf' && workspaceLocation?.kind === 'pdf'
            ? workspaceLocation
            : cachedLocation ?? workspaceLocation;
        if (locationToRestore) {
          // 回切边界以已 flush 的 Workspace 位置为准。PDF Runtime 可能在
          // 挂起期间被迟到的布局事件改写;不能让未经验证的活对象覆盖快照。
          useWorkspaceStore.getState().setViewLocation(viewId, locationToRestore);
        }
        useReaderRuntime.getState().setDocumentLifecycle(viewId, 'active');
        useWorkspaceStore.getState().setActiveView(groupId, viewId);
        try {
          await suspendViewRuntime(dependencies, previousViewId);
        } catch (error) {
          // 目标先提升只是为给 LRU 留出回切槽位；旧视图 flush 失败时恢复
          // 原活动关系与目标 suspended 状态，不能让用户停在未落盘的半切换上。
          const restored = targetCache.suspend(lookup.entry);
          for (const evicted of restored.evicted) {
            useReaderRuntime.getState().removeDocument(evicted.viewId);
          }
          if (restored.admitted) {
            useReaderRuntime.getState().setDocumentLifecycle(viewId, 'suspended');
          } else {
            useReaderRuntime.getState().removeDocument(viewId);
          }
          useWorkspaceStore.getState().setActiveView(groupId, previousViewId);
          throw error;
        }
        return targetDocument;
      }
      useReaderRuntime.getState().removeDocument(viewId);
    }
    await suspendViewRuntime(dependencies, previousViewId);
  }
  useWorkspaceStore.getState().setActiveView(groupId, viewId);
  if (view.sourceMode) return null;
  const document = await ensureActiveViewDocument(dependencies, viewId, material, options);
  return document;
}

/** 材料格式的展示用途(供 PDF 视口命令判断当前材料是否支持 PDF 视口)。 */
function materialFormatOf(material: ReadingMaterial): MaterialFormat {
  return formatFromSourceFileName(material.sourceFileName);
}

/**
 * 交给 ReadingView 组件在自身容器内挂载 BookDocument,并接线位置持久化与导航历史。
 * 返回持久化器；其生命周期由 reader.activateView、reader.closeView 与应用关闭流程统一管理。
 */
export function mountViewDocument(
  document: BookDocument,
  viewId: string,
  container: HTMLElement,
  location: ReadingLocation | null,
  dependencies: ReaderCommandDependencies,
): ThrottledPositionPersister {
  const existingMount = activeMounts.get(viewId);
  if (existingMount?.document === document && !existingMount.disposed) {
    const containerChanged = existingMount.container !== container;
    let attached = false;
    if (containerChanged) {
      attached = document.attach?.(container) ?? false;
      existingMount.container = container;
    }
    if (
      location &&
      existingMount.restoringLocation !== serializeReadingLocation(location) &&
      (containerChanged || JSON.stringify(document.getLocation()) !== serializeReadingLocation(location))
    ) {
      const targetLocation = location;
      existingMount.restoringLocation = serializeReadingLocation(targetLocation);
      existingMount.restoring = true;
      const restoreGeneration = existingMount.restoreGeneration + 1;
      existingMount.restoreGeneration = restoreGeneration;
      useReaderRuntime.getState().setDocumentState(viewId, { status: 'loading' });
      void restoreAttachedReaderLocation(document, targetLocation)
        .then(async () => {
          if (
            activeMounts.get(viewId) !== existingMount ||
            existingMount.restoreGeneration !== restoreGeneration
          ) return;
          if (!isPdfAtRestoredLocation(document, targetLocation)) return;
          existingMount.restoring = false;
          useWorkspaceStore.getState().setViewLocation(viewId, targetLocation);
          existingMount.persister.update(targetLocation);
          useReaderRuntime.getState().setDocumentState(viewId, { status: 'ready' });
        })
        .catch((error: unknown) => {
          console.error('缓存阅读位置恢复失败', { viewId, error });
          if (
            activeMounts.get(viewId) === existingMount &&
            existingMount.restoreGeneration === restoreGeneration
          ) {
            useReaderRuntime.getState().setDocumentState(viewId, {
              status: 'error',
              message: '阅读位置恢复失败,请重新打开该材料。',
            });
          }
        })
        .finally(() => {
          if (
            activeMounts.get(viewId) !== existingMount ||
            existingMount.restoreGeneration !== restoreGeneration
          ) return;
          existingMount.restoring = false;
          existingMount.restoringLocation = null;
        });
    }
    return existingMount.persister;
  }
  existingMount?.dispose();

  // 缓存命中时只移动已打开的 renderer，不重新执行 EPUB/Markdown 解析或建立
  // renderer；新建 Runtime 才进入 document.open()。
  const attached = document.attach?.(container) ?? false;
  const readiness = prepareViewMountReadiness(viewId);
  useReaderRuntime.getState().setDocumentState(viewId, { status: 'loading' });
  const persister = new ThrottledPositionPersister({
    save: async (next) => {
      useWorkspaceStore.getState().setViewLocation(viewId, next);
      try {
        await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
      } catch (error) {
        console.error('保存阅读位置失败', error);
        throw error;
      }
    },
  });
  persisters.set(viewId, persister);
  const removeReadErrorListener = document.onReadError?.((error) => {
    reportReaderReadFailure(viewId, error);
  });
  const removeLocationListener = document.onLocationChange((next) => {
    if (activeMount.restoring) {
      return;
    }
    commitLocation(next);
  });
  const removeInternalLinkListener = document.onInternalLink((href) => {
    if (!isCurrentViewMount(viewId, document)) return;
    navigationIntents.set(viewId, 'push');
    void document.goToHref(href).catch((error: unknown) => {
      reportReaderNavigationFailure(viewId, error);
    });
  });
  const removeExternalLinkListener = document.onExternalLink((href) => {
    if (!isCurrentViewMount(viewId, document)) return;
    useShellUiStore.getState().openExternalLinkConfirm(href);
  });
  // 缓存命中也要用 Workspace 中最后一次已 flush 的位置校正 paginator。
  // Foliate 在隐藏根与真实容器之间切换时可能先派发章节起点 relocate;
  // 恢复期间忽略该中间事件,避免它覆盖用户的精确位置。
  const activeMount: ActiveViewMount = {
    document,
    container,
    persister,
    restoring: location !== null,
    restoringLocation: location ? serializeReadingLocation(location) : null,
    restoreGeneration: location ? 1 : 0,
    disposed: false,
    dispose: () => {
      if (activeMount.disposed) return;
      activeMount.disposed = true;
      activeMount.restoreGeneration += 1;
      removeReadErrorListener?.();
      removeLocationListener();
      removeInternalLinkListener();
      removeExternalLinkListener();
    },
  };
  activeMounts.set(viewId, activeMount);
  const restoreGeneration = activeMount.restoreGeneration;

  // 挂载时应用该材料实际生效的排版(材料级覆盖优先,否则回退全局默认)。
  const materialId = findView(viewId)?.materialId;
  // 挂起 Runtime 已经保留当前 paginator 的排版。回切时再次写入 renderer
  // attribute 会触发无谓的重排,部分 Foliate 版本会把位置归一到章节起点;
  // 排版命令本身会同步更新所有活 Runtime,因此命中路径无需再次应用。
  if (materialId && !attached) {
    const store = useWorkspaceStore.getState();
    document.applyTypography(
      resolveTypography(store.globalReadingTypography, store.materialTypography[materialId] ?? null),
    );
  }

  // 位置变化:按本次导航意图更新当前阅读位置与导航历史。
  function commitLocation(next: ReadingLocation): void {
    if (!isCurrentViewMount(viewId, document)) return;
    const intent = navigationIntents.get(viewId) ?? 'replace';
    navigationIntents.delete(viewId);
    if (intent === 'push') {
      useWorkspaceStore.getState().pushViewLocation(viewId, next);
    } else {
      useWorkspaceStore.getState().setViewLocation(viewId, next);
    }
    persister.update(next);
  }

  void (attached ? Promise.resolve() : document.open(container))
    .then(async () => {
      if (!isCurrentViewMount(viewId, document)) return;
      if (
        location &&
        activeMount.restoring &&
        activeMount.restoreGeneration === restoreGeneration
      ) {
        navigationIntents.set(viewId, 'replace');
        if (attached) {
          await waitForReaderRestoreBeforeNavigation(location);
        }
        await document.goToLocation(location);
        if (
          !isCurrentViewMount(viewId, document) ||
          activeMount.restoreGeneration !== restoreGeneration
        ) return;
        if (!isPdfAtRestoredLocation(document, location)) return;
        // 恢复期间的首屏/重排事件只属于渲染器初始化,不能覆盖 Workspace
        // 中已经存在的最后位置。恢复成功后以请求位置作为本次提交值。
        activeMount.restoring = false;
        commitLocation(location);
        // Foliate 的分页器可能在 goTo() 返回后再派发一次章节起点 relocate;
        // 在两个绘制帧内继续屏蔽该旧事件,否则精确 CFI 会被回退到章节开头。
        activeMount.restoring = true;
        await waitForReaderRestoreSettling();
        if (
          !isCurrentViewMount(viewId, document) ||
          activeMount.restoreGeneration !== restoreGeneration
        ) return;
        activeMount.restoring = false;
        activeMount.restoringLocation = null;
      } else if (!attached) {
        activeMount.restoring = false;
        activeMount.restoringLocation = null;
      }
      readiness.resolve();
      // 文档打开后加载该材料批注并绘制到覆盖层。
      if (dependencies.annotationRepository) {
        void loadAnnotationsForView(
          { annotationRepository: dependencies.annotationRepository },
          viewId,
        ).catch((error: unknown) => {
          console.error('加载批注失败', error);
        });
      }
      useReaderRuntime.getState().setDocumentState(viewId, { status: 'ready' });
    })
    .catch(async (error: unknown) => {
      readiness.resolve();
      if (!isCurrentViewMount(viewId, document)) return;
      if (activeMounts.get(viewId)?.document === document) {
        await flushAndClearViewRuntimeBindings(viewId, dependencies);
        registeredReaderRuntimeCache?.remove(viewId);
        useReaderRuntime.getState().removeDocument(viewId);
      }
      useReaderRuntime.getState().setDocumentState(viewId, {
        status: 'error',
        message: describeDocumentOpenError(error),
      });
      const failedView = findView(viewId);
      console.error('打开阅读文档失败', {
        viewId,
        materialId: failedView?.materialId ?? null,
        format: document.format,
        error,
      });
    });

  return persister;
}

export function registerReaderCommands(
  registry: CommandRegistry,
  dependencies: ReaderCommandDependencies,
): void {
  registeredReaderRuntimeCache = getReaderRuntimeCache(dependencies);
  const registerEditorGroupSplit = (
    commandId: typeof COMMAND_IDS.workbenchSplitEditorGroupRight | typeof COMMAND_IDS.workbenchSplitEditorGroupDown,
    direction: 'right' | 'down',
  ) => {
    registry.register(commandId, (..._args: unknown[]) => enqueueRuntimeTransition(async () => {
      const result = useWorkspaceStore.getState().splitEditorGroup(direction);
      if (!result) return;

      if (result.viewId) {
        await ensureActiveViewDocument(dependencies, result.viewId);
      }
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
    }));
  };

  registerEditorGroupSplit(COMMAND_IDS.workbenchSplitEditorGroupRight, 'right');
  registerEditorGroupSplit(COMMAND_IDS.workbenchSplitEditorGroupDown, 'down');

  registry.register(COMMAND_IDS.libraryOpenBook, (...args: unknown[]) => enqueueRuntimeTransition(async () => {
    const material = args[0] as ReadingMaterial | undefined;
    const location = (args[1] as ReadingLocation | null | undefined) ?? null;
    if (!material) {
      throw new Error('打开书籍命令缺少阅读材料参数');
    }
    const activeGroupId = useWorkspaceStore.getState().activeEditorGroupId;
    const previousViewId = getActiveViewId(activeGroupId);
    const existingView = findViewInGroupByMaterialId(activeGroupId, material.id);
    const viewId = useWorkspaceStore.getState().openView(material.id, { activate: false });

    try {
      const document = await activateViewRuntime(
        dependencies,
        viewId,
        material,
        previousViewId,
        { preferManagedMarkdownSource: existingView === undefined },
      );
      if (!document) {
        if (findView(viewId)?.sourceMode) {
          await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
          useShellUiStore.getState().requestCompactActivityPanelDismissal();
          return viewId;
        }
        if (getActiveViewId() !== viewId) {
          await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
          return;
        }
        throw new Error(`无法打开阅读材料:${material.title}`);
      }
      if (location) {
        useWorkspaceStore.getState().setViewLocation(viewId, location);
      }
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
      useShellUiStore.getState().requestCompactActivityPanelDismissal();
      return viewId;
    } catch (error) {
      if (getActiveViewId() !== viewId) {
        return viewId;
      }
      throw error;
    }
  }));

  // 从主要材料批注面板跳转:优先复用已有视图,否则在当前组打开该材料。
  // 失联批注绝不猜测位置,只保留并提示用户。
  registry.register(COMMAND_IDS.annotationGoTo, (...args: unknown[]) => enqueueRuntimeTransition(async () => {
    const materialId = args[0] as string | undefined;
    const annotationId = args[1] as string | undefined;
    if (!materialId || !annotationId) return;

    let annotation = useAnnotationStore
      .getState()
      .getMaterialAnnotations(materialId)
      .find((item) => item.id === annotationId);
    if (!annotation && dependencies.annotationRepository) {
      const loaded = await dependencies.annotationRepository.listByMaterial(materialId);
      useAnnotationStore.getState().setMaterialAnnotations(materialId, loaded);
      annotation = loaded.find((item) => item.id === annotationId);
    }
    if (!annotation) return;
    if (annotation.anchor.recoveryState === 'orphaned') {
      useShellUiStore.getState().setStatusMessage('失联批注无法安全跳转');
      return;
    }

    const material = useLibraryStore.getState().materials.find((item) => item.id === materialId);
    if (!material) return;

    const activeGroupId = useWorkspaceStore.getState().activeEditorGroupId;
    const targetView =
      findViewInGroupByMaterialId(activeGroupId, materialId) ?? findViewByMaterialId(materialId);
    const targetGroupId = targetView ? findViewGroupId(targetView.id) : activeGroupId;
    const previousViewId = targetGroupId ? getActiveViewId(targetGroupId) : null;
    const viewId = targetView?.id ?? useWorkspaceStore.getState().openView(materialId, { activate: false });

    const document = await activateViewRuntime(dependencies, viewId, material, previousViewId);
    if (!document) return;
    await waitForViewMount(viewId);
    await jumpToCfi(viewId, dependencies, annotation.anchor.cfi);
  }));

  registry.register(COMMAND_IDS.readerActivateView, (...args: unknown[]) => enqueueRuntimeTransition(async () => {
    const viewId = args[0] as string | undefined;
    const material = args[1] as ReadingMaterial | undefined;
    if (!viewId) return;

    await activateViewRuntime(dependencies, viewId, material);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  }));

  registry.register(COMMAND_IDS.readerNextPage, (...args: unknown[]) => enqueueRuntimeTransition(async () => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    navigationIntents.set(viewId, 'replace');
    try {
      await useReaderRuntime.getState().getDocument(viewId)?.next();
    } catch (error) {
      reportReaderNavigationFailure(viewId, error);
    }
  }));

  registry.register(COMMAND_IDS.readerPrevPage, (...args: unknown[]) => enqueueRuntimeTransition(async () => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    navigationIntents.set(viewId, 'replace');
    try {
      await useReaderRuntime.getState().getDocument(viewId)?.prev();
    } catch (error) {
      reportReaderNavigationFailure(viewId, error);
    }
  }));

  registry.register(COMMAND_IDS.readerGoToHref, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const href = args[1] as string | undefined;
    if (!viewId || !href) return;
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!document) return;
    navigationIntents.set(viewId, 'push');
    try {
      await document.goToHref(href);
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
    } catch (error) {
      reportReaderNavigationFailure(viewId, error);
    }
  });

  registry.register(COMMAND_IDS.readerBack, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    const view = findView(viewId);
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!view || !document) return;
    const step = historyBack(view.history);
    if (!step) return;
    useWorkspaceStore.getState().setViewHistory(viewId, step.history);
    navigationIntents.set(viewId, 'replace');
    await document.goToLocation(step.location);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerForward, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    const view = findView(viewId);
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!view || !document) return;
    const step = historyForward(view.history);
    if (!step) return;
    useWorkspaceStore.getState().setViewHistory(viewId, step.history);
    navigationIntents.set(viewId, 'replace');
    await document.goToLocation(step.location);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerOpenExternalUrl, async (...args: unknown[]) => {
    const url = args[0] as string | undefined;
    if (!url || !dependencies.externalUrlOpener) {
      return;
    }
    // 只把 http/https 交给系统浏览器,拦截其它 scheme(样本清洗已移除危险 URL,
    // 这里作为纵深防线,避免把 file:// 等交给系统处理)。
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return;
    }
    await dependencies.externalUrlOpener.open(url);
  });

  registry.register(COMMAND_IDS.readerSearchOpen, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    useSearchStore.getState().open(viewId);
  });

  registry.register(COMMAND_IDS.readerSearchClose, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    clearSearch(viewId);
    useSearchStore.getState().close(viewId);
  });

  registry.register(COMMAND_IDS.readerSearchRun, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const query = args[1] as string | undefined;
    if (!viewId || typeof query !== 'string') return;
    const view = useSearchStore.getState().getView(viewId);
    runSearch(viewId, { query, matchCase: view.matchCase, mode: view.mode });
  });

  registry.register(COMMAND_IDS.readerSearchToggleCase, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const queryFromArg = args[1] as string | undefined;
    if (!viewId) return;
    const view = useSearchStore.getState().getView(viewId);
    const matchCase = !view.matchCase;
    useSearchStore.getState().setMatchCase(viewId, matchCase);
    // 用当前输入草稿重搜(若调用方未给草稿则回退到上次已提交查询)。
    runSearch(viewId, {
      query: queryFromArg ?? view.query,
      matchCase,
      mode: view.mode,
    });
  });

  registry.register(COMMAND_IDS.readerSearchToggleMode, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const queryFromArg = args[1] as string | undefined;
    if (!viewId) return;
    const view = useSearchStore.getState().getView(viewId);
    const mode = view.mode === 'regex' ? 'text' : 'regex';
    useSearchStore.getState().setMode(viewId, mode);
    runSearch(viewId, {
      query: queryFromArg ?? view.query,
      matchCase: view.matchCase,
      mode,
    });
  });

  registry.register(COMMAND_IDS.readerSearchNext, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    await navigateSearchResult(viewId, dependencies, 1);
  });

  registry.register(COMMAND_IDS.readerSearchPrev, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    await navigateSearchResult(viewId, dependencies, -1);
  });

  registry.register(COMMAND_IDS.readerSearchGoTo, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const cfi = args[1] as string | undefined;
    if (!viewId || !cfi) return;
    await jumpToCfi(viewId, dependencies, cfi);
  });

  registry.register(COMMAND_IDS.readerCloseView, (...args: unknown[]) => enqueueRuntimeTransition(async () => {
    const viewIdParam = args[0] as string | undefined;
    const targetId = viewIdParam ?? getActiveViewId();
    if (!targetId) return;
    const targetGroupId = findViewGroupId(targetId);

    // Markdown 脏文档:先询问保存/放弃/取消,不直接关闭。
    const targetView = findView(targetId);
    if (targetView) {
      const session = useMarkdownSessionStore.getState().getSession(targetView.materialId);
      // 会话仅由打开 Markdown 阅读视图时建立;存在且脏时才拦截。
      if (session?.dirty) {
        useShellUiStore.getState().openMarkdownDirtyClose(targetId, 'close');
        return;
      }
    }

    await disposeViewRuntime(dependencies, targetId);
    useWorkspaceStore.getState().closeView(targetId);
    const nextViewId = targetGroupId ? getActiveViewId(targetGroupId) : getActiveViewId();
    if (nextViewId) {
      await ensureActiveViewDocument(dependencies, nextViewId);
    }
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  }));

  registry.register(COMMAND_IDS.readerApplyTypography, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const patch = (args[1] as Partial<ReadingTypography> | undefined) ?? null;
    if (!viewId || !patch) return;
    const view = findView(viewId);
    if (!view) return;

    const store = useWorkspaceStore.getState();
    const clamped = clampTypographyPatch(patch);
    const merged = {
      ...store.materialTypography[view.materialId],
      ...clamped,
    };
    useWorkspaceStore.getState().setMaterialTypography(view.materialId, merged);

    const effective = resolveTypography(
      store.globalReadingTypography,
      useWorkspaceStore.getState().materialTypography[view.materialId],
    );
    for (const [openViewId, document] of useReaderRuntime.getState().documents) {
      if (findView(openViewId)?.materialId === view.materialId) {
        document.applyTypography(effective);
      }
    }
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerResetTypography, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    const view = findView(viewId);
    if (!view) return;

    useWorkspaceStore.getState().resetMaterialTypography(view.materialId);
    const store = useWorkspaceStore.getState();
    const effective = resolveTypography(store.globalReadingTypography, null);
    for (const [openViewId, document] of useReaderRuntime.getState().documents) {
      if (findView(openViewId)?.materialId === view.materialId) {
        document.applyTypography(effective);
      }
    }
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerSetGlobalTypography, async (...args: unknown[]) => {
    const patch = (args[0] as Partial<ReadingTypography> | undefined) ?? null;
    if (!patch) return;
    const store = useWorkspaceStore.getState();
    const nextGlobal = {
      ...store.globalReadingTypography,
      ...clampTypographyPatch(patch),
    };
    useWorkspaceStore.getState().setGlobalReadingTypography(nextGlobal);
    // 全局默认变化后,所有没有材料级覆盖的开放视图立即跟随生效。
    for (const viewId of useReaderRuntime.getState().documents.keys()) {
      const view = findView(viewId);
      if (!view) continue;
      const current = useWorkspaceStore.getState();
      if (current.materialTypography[view.materialId]) continue;
      useReaderRuntime.getState().getDocument(viewId)?.applyTypography(nextGlobal);
    }
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerSetPdfViewport, (...args: unknown[]) => enqueueRuntimeTransition(async () => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const zoom = args[1] as number | undefined;
    const fit = args[2] as PdfFitMode | undefined;
    if (!viewId || typeof zoom !== 'number' || !fit) return;
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!(document instanceof PdfBookDocument)) return;
    const clamped = Math.min(400, Math.max(25, Math.round(zoom)));
    document.setViewport(clamped, fit);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  }));

  registry.register(COMMAND_IDS.readerSetPdfFlow, (...args: unknown[]) => enqueueRuntimeTransition(async () => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const flow = args[1] as 'paginated' | 'scrolled' | undefined;
    if (!viewId || !flow) return;
    const view = findView(viewId);
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!view || !(document instanceof PdfBookDocument)) return;
    const store = useWorkspaceStore.getState();
    const merged = { ...store.materialTypography[view.materialId], flow };
    useWorkspaceStore.getState().setMaterialTypography(view.materialId, merged);
    const effective = resolveTypography(
      store.globalReadingTypography,
      useWorkspaceStore.getState().materialTypography[view.materialId],
    );
    for (const [openViewId, openDocument] of useReaderRuntime.getState().documents) {
      if (
        openDocument instanceof PdfBookDocument &&
        findView(openViewId)?.materialId === view.materialId
      ) {
        openDocument.applyTypography(effective);
      }
    }
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  }));

  registry.register(COMMAND_IDS.readerRestoreView, async (...args: unknown[]) => {
    const viewId = args[0] as string | undefined;
    const material = args[1] as ReadingMaterial | undefined;
    const location = (args[2] as ReadingLocation | null | undefined) ?? null;
    if (!viewId || !material) return;

    if (!isViewActive(viewId)) return;
    if (location) {
      useWorkspaceStore.getState().setViewLocation(viewId, location);
    }
    await ensureActiveViewDocument(dependencies, viewId, material);
  });
}

/**
 * 在指定视图的搜索结果中前进/后退一步并跳转到对应命中。
 * `direction` 为 1 表示下一个,`-1` 表示上一个;越界时循环。
 */
async function navigateSearchResult(
  viewId: string,
  dependencies: ReaderCommandDependencies,
  direction: 1 | -1,
): Promise<void> {
  const store = useSearchStore.getState();
  const view = store.getView(viewId);
  const count = view.matches.length;
  if (count === 0) return;

  const current = view.currentIndex;
  const index = current < 0 ? (direction === 1 ? 0 : count - 1) : (current + direction + count) % count;
  const cfi = view.matches[index]!.cfi;
  store.setCurrentIndex(viewId, index);

  await jumpToCfi(viewId, dependencies, cfi);
}

/** 在当前视图内显式跳到指定 CFI:压入导航历史并持久化位置。 */
async function jumpToCfi(
  viewId: string,
  dependencies: ReaderCommandDependencies,
  cfi: string,
): Promise<void> {
  const document = useReaderRuntime.getState().getDocument(viewId);
  if (!document) return;
  navigationIntents.set(viewId, 'push');
  if (isPdfTextAnchor(cfi)) {
    if (document instanceof PdfBookDocument) {
      await document.goToPdfAnchor(cfi);
    } else {
      const loc = decodePdfTextAnchor(cfi);
      await document.goToLocation({
        kind: 'pdf',
        page: loc?.page ?? 1,
        scrollTop: 0,
        zoom: 100,
        fit: 'width',
      });
    }
  } else if (document instanceof MarkdownBookDocument) {
    await document.goToLocation({ kind: 'markdown', cfi });
  } else {
    await document.goToLocation({ kind: 'epub', cfi });
  }
  await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
}

/**
 * 把排版补丁中的数值字段收敛到合理区间,防止脏数据把文档字号/行距等
 * 推到失控范围。只处理已知字段,其它字段原样透传。
 */
function clampTypographyPatch(
  patch: Partial<ReadingTypography>,
): Partial<ReadingTypography> {
  const next = { ...patch };
  if (typeof next.fontSize === 'number') {
    next.fontSize = Math.min(48, Math.max(10, Math.round(next.fontSize)));
  }
  if (typeof next.lineHeight === 'number') {
    next.lineHeight = Math.min(3, Math.max(1, Math.round(next.lineHeight * 10) / 10));
  }
  if (typeof next.margin === 'number') {
    next.margin = Math.min(160, Math.max(0, Math.round(next.margin)));
  }
  if (typeof next.gap === 'number') {
    next.gap = Math.min(30, Math.max(0, Math.round(next.gap)));
  }
  return next;
}

/** 导出前强制落库当前打开视图的最新阅读位置。 */
export async function flushReaderPositions(): Promise<void> {
  for (const persister of persisters.values()) {
    await persister.flush();
  }
}

/** 应用关闭时把当前视图位置 flush、取消搜索并关闭渲染器。 */
export async function flushAndCloseAllReaderViews(): Promise<void> {
  runtimeGeneration += 1;
  pendingDocumentCreations.clear();
  for (const persister of persisters.values()) {
    await persister.dispose();
  }
  persisters.clear();
  navigationIntents.clear();
  for (const viewId of runtimeInputCleanups.keys()) clearReaderRuntimeInput(viewId);
  cancelAllSearches();
  useReaderRuntime.getState().closeAll();
  registeredReaderRuntimeCache?.clear();
}
