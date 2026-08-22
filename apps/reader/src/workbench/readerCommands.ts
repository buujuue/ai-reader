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
import { inspectPdf } from '../domain/reader/pdf/pdfInspector';
import type { PdfFileSource, PdfJsLib } from '../domain/reader/pdf/pdfLibrary';
import { loadPdfLib } from '../domain/reader/pdf/pdfLibrary';
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
import { cancelAllSearches, clearSearch, runSearch } from './searchRunner';
import { useSearchStore } from './searchStore';
import { ThrottledPositionPersister } from './positionPersister';
import { loadAnnotationsForView } from './annotationCommands';
import { useMarkdownSessionStore } from './markdownSessionStore';
import { useAnnotationStore } from './annotationStore';
import { useLibraryStore } from './libraryStore';
import { useReaderRuntime } from './readerRuntime';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';
import { readManagedMarkdownText } from './markdownSource';
import { serializeWorkspaceState } from './workbenchCommands';
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
  removeReadErrorListener: (() => void) | undefined;
}

const activeMounts = new Map<string, ActiveViewMount>();
const defaultEpubDerivedCache = createEpubDerivedCache<string>();
const defaultCanonicalSearchIndexCache = createCanonicalSearchIndexCache();
const defaultEpubDerivedTocCache = createEpubDerivedTocCache();

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

/** 同一阅读视图尚在打开时,复用进行中的文档创建任务,避免快速重复点击触发并发读取。 */
const pendingDocumentCreations = new Map<string, Promise<BookDocument | null>>();

/** 用于让应用关闭时，尚未完成的惰性恢复不会重新把文档放回 Runtime。 */
let runtimeGeneration = 0;

/** 串行化标签激活/关闭/打开，避免异步 flush 与文档创建互相覆盖最新用户意图。 */
let runtimeTransitionQueue: Promise<void> = Promise.resolve();

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
 * 读取并检查托管 PDF 字节,构造 BookDocument。
 * 返回 null 表示材料不是可读的 PDF。
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
  let metadata;
  try {
    const result = await inspectPdf(source, dependencies.pdfLib);
    metadata = result.metadata;
  } catch (error) {
    throw new Error(`解析 PDF 失败：${describeDocumentOpenError(error)}`);
  }
  return new PdfBookDocument({
    source,
    metadata,
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
): Promise<BookDocument | null> {
  let text: string;
  try {
    text = await readManagedMarkdownText(dependencies.importRepository, material.id);
  } catch (error) {
    throw new Error(`读取 Markdown 失败：${describeDocumentOpenError(error)}`);
  }
  // 打开 Markdown 视图时建立或复用该材料的共享会话(缓冲区、脏标记、已保存版本)。
  useMarkdownSessionStore
    .getState()
    .openSession(material.id, text, material.documentVersion);
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

/** 按材料格式分派创建对应 BookDocument;未知格式返回 null。 */
async function createDocumentForMaterial(
  dependencies: ReaderCommandDependencies,
  material: ReadingMaterial,
): Promise<BookDocument | null> {
  const format = formatFromSourceFileName(material.sourceFileName);
  switch (format) {
    case 'pdf':
      return createPdfDocument(dependencies, material);
    case 'epub':
      return createEpubDocument(dependencies, material);
    case 'markdown':
      return createMarkdownDocument(dependencies, material);
    default:
      return null;
  }
}

function getOrCreatePendingDocument(
  dependencies: ReaderCommandDependencies,
  viewId: string,
  material: ReadingMaterial,
): Promise<BookDocument | null> {
  const pending = pendingDocumentCreations.get(viewId);
  if (pending) return pending;

  const creation = createDocumentForMaterial(dependencies, material);
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

/** 释放失活标签的活对象，但保留 Workspace Store 中的标签、位置和历史。 */
async function disposeViewRuntime(viewId: string): Promise<void> {
  const activeMount = activeMounts.get(viewId);
  activeMount?.removeReadErrorListener?.();
  activeMounts.delete(viewId);
  const persister = persisters.get(viewId);
  if (persister) {
    await persister.dispose();
    persisters.delete(viewId);
  }
  navigationIntents.delete(viewId);
  viewMountReadiness.get(viewId)?.resolve();
  viewMountReadiness.delete(viewId);
  clearSearch(viewId);
  useSearchStore.getState().close(viewId);
  useReaderRuntime.getState().removeDocument(viewId);
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
      .filter((view) => view.materialId === materialId && isViewActive(view.id))
      .map((view) => view.id);
    for (const viewId of viewIds) {
      await disposeViewRuntime(viewId);
      await ensureActiveViewDocument(dependencies, viewId, material);
    }
  });
}

async function ensureActiveViewDocument(
  dependencies: ReaderCommandDependencies,
  viewId: string,
  material?: ReadingMaterial,
): Promise<BookDocument | null> {
  const runtime = useReaderRuntime.getState();
  const existing = runtime.getDocument(viewId);
  if (existing) return existing;

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

  const generation = runtimeGeneration;
  let document: BookDocument | null;
  try {
    document = await getOrCreatePendingDocument(dependencies, viewId, targetMaterial);
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
  useReaderRuntime.getState().setDocument(viewId, document);
  return document;
}

async function activateViewRuntime(
  dependencies: ReaderCommandDependencies,
  viewId: string,
  material?: ReadingMaterial,
  previousViewIdOverride?: string | null,
): Promise<BookDocument | null> {
  const view = findView(viewId);
  const groupId = findViewGroupId(viewId);
  if (!view || !groupId) return null;

  const previousViewId =
    previousViewIdOverride === undefined ? getActiveViewId(groupId) : previousViewIdOverride;
  if (previousViewId && previousViewId !== viewId) {
    await disposeViewRuntime(previousViewId);
  }
  useWorkspaceStore.getState().setActiveView(groupId, viewId);
  return ensureActiveViewDocument(dependencies, viewId, material);
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
  if (existingMount?.document === document) {
    return existingMount.persister;
  }
  existingMount?.removeReadErrorListener?.();

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
  activeMounts.set(viewId, { document, container, persister, removeReadErrorListener });

  // 挂载时应用该材料实际生效的排版(材料级覆盖优先,否则回退全局默认)。
  const materialId = findView(viewId)?.materialId;
  if (materialId) {
    const store = useWorkspaceStore.getState();
    document.applyTypography(
      resolveTypography(store.globalReadingTypography, store.materialTypography[materialId] ?? null),
    );
  }

  // 位置变化:按本次导航意图更新当前阅读位置与导航历史。
  document.onLocationChange((next) => {
    const intent = navigationIntents.get(viewId) ?? 'replace';
    navigationIntents.delete(viewId);
    if (intent === 'push') {
      useWorkspaceStore.getState().pushViewLocation(viewId, next);
    } else {
      useWorkspaceStore.getState().setViewLocation(viewId, next);
    }
    persister.update(next);
  });

  // 书内链接:显式跳转,压入历史节点。
  document.onInternalLink((href) => {
    navigationIntents.set(viewId, 'push');
    void document.goToHref(href).catch((error: unknown) => {
      reportReaderNavigationFailure(viewId, error);
    });
  });

  // 外部链接:先展示目标,经用户确认后由统一 Command 交给系统浏览器。
  // 阅读 WebView 自身不导航到外部站点(宿主已 preventDefault)。
  document.onExternalLink((href) => {
    useShellUiStore.getState().openExternalLinkConfirm(href);
  });

  void document.open(container)
    .then(async () => {
      if (location) {
        navigationIntents.set(viewId, 'replace');
        await document.goToLocation(location);
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
    .catch((error: unknown) => {
      readiness.resolve();
      if (activeMounts.get(viewId)?.document === document) {
        activeMounts.delete(viewId);
        persisters.delete(viewId);
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
    const viewId = useWorkspaceStore.getState().openView(material.id);

    try {
      const document = await activateViewRuntime(dependencies, viewId, material, previousViewId);
      if (!document) {
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
    } catch (error) {
      if (getActiveViewId() !== viewId) {
        return;
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
    const viewId = targetView?.id ?? useWorkspaceStore.getState().openView(materialId);

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

  registry.register(COMMAND_IDS.readerNextPage, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    navigationIntents.set(viewId, 'replace');
    try {
      await useReaderRuntime.getState().getDocument(viewId)?.next();
    } catch (error) {
      reportReaderNavigationFailure(viewId, error);
    }
  });

  registry.register(COMMAND_IDS.readerPrevPage, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    navigationIntents.set(viewId, 'replace');
    try {
      await useReaderRuntime.getState().getDocument(viewId)?.prev();
    } catch (error) {
      reportReaderNavigationFailure(viewId, error);
    }
  });

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

    await disposeViewRuntime(targetId);
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

  registry.register(COMMAND_IDS.readerSetPdfViewport, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const zoom = args[1] as number | undefined;
    const fit = args[2] as PdfFitMode | undefined;
    if (!viewId || typeof zoom !== 'number' || !fit) return;
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!(document instanceof PdfBookDocument)) return;
    const clamped = Math.min(400, Math.max(25, Math.round(zoom)));
    document.setViewport(clamped, fit);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerSetPdfFlow, async (...args: unknown[]) => {
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
  });

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
  cancelAllSearches();
  useReaderRuntime.getState().closeAll();
}
