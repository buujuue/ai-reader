import type { CommandRegistry } from '../commands/commandRegistry';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { ExternalUrlOpener } from '../app/externalUrlOpener';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import type { BookDocument } from '../domain/reader/bookDocument';
import { EpubBookDocument } from '../domain/reader/epubBookDocument';
import {
  createFoliateViewHostFactory,
  type FoliateViewHostFactory,
} from '../domain/reader/foliateViewHost';
import { back as historyBack, forward as historyForward } from '../domain/reader/navigationHistory';
import type { PdfFitMode } from '../domain/reader/readingLocation';
import { PdfBookDocument } from '../domain/reader/pdf/pdfBookDocument';
import { inspectPdf } from '../domain/reader/pdf/pdfInspector';
import type { PdfJsLib } from '../domain/reader/pdf/pdfLibrary';
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
import { cancelAllSearches, cancelSearch, clearSearch, runSearch } from './searchRunner';
import { useSearchStore } from './searchStore';
import { ThrottledPositionPersister } from './positionPersister';
import { loadAnnotationsForView } from './annotationCommands';
import { useMarkdownSessionStore } from './markdownSessionStore';
import { useReaderRuntime } from './readerRuntime';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';
import { serializeWorkspaceState } from './workbenchCommands';
import { findView, getActiveViewId } from './viewUtils';

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
}

/**
 * 阅读位置持久化器注册表(活对象,不进入持久化状态)。
 * 每个打开中的阅读视图对应一个节流写入器,关闭时强制 flush。
 */
const persisters = new Map<string, ThrottledPositionPersister>();

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
  const bytes = await dependencies.importRepository.readManagedFile(material.id);
  let metadata;
  try {
    const result = await inspectEpub(bytes);
    metadata = result.metadata;
  } catch {
    return null;
  }
  return new EpubBookDocument({
    bytes,
    metadata,
    viewHostFactory: dependencies.viewHostFactory ?? createFoliateViewHostFactory(),
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
  const bytes = await dependencies.importRepository.readManagedFile(material.id);
  let metadata;
  try {
    const result = await inspectPdf(bytes, dependencies.pdfLib);
    metadata = result.metadata;
  } catch {
    return null;
  }
  return new PdfBookDocument({
    bytes,
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
  let bytes: Uint8Array;
  try {
    bytes = await dependencies.importRepository.readManagedFile(material.id);
  } catch {
    return null;
  }
  const text = new TextDecoder('utf-8').decode(bytes);
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

/** 材料格式的展示用途(供 PDF 视口命令判断当前材料是否支持 PDF 视口)。 */
function materialFormatOf(material: ReadingMaterial): MaterialFormat {
  return formatFromSourceFileName(material.sourceFileName);
}

/**
 * 交给 ReadingView 组件在自身容器内挂载 BookDocument,并接线位置持久化与导航历史。
 * 返回持久化器,组件卸载时应 dispose。
 */
export function mountViewDocument(
  document: BookDocument,
  viewId: string,
  container: HTMLElement,
  location: ReadingLocation | null,
  dependencies: ReaderCommandDependencies,
): ThrottledPositionPersister {
  const persister = new ThrottledPositionPersister({
    save: async (next) => {
      useWorkspaceStore.getState().setViewLocation(viewId, next);
      try {
        await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
      } catch (error) {
        console.error('保存阅读位置失败', error);
      }
    },
  });
  persisters.set(viewId, persister);

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
      console.error('书内链接导航失败', error);
    });
  });

  // 外部链接:先展示目标,经用户确认后由统一 Command 交给系统浏览器。
  // 阅读 WebView 自身不导航到外部站点(宿主已 preventDefault)。
  document.onExternalLink((href) => {
    useShellUiStore.getState().openExternalLinkConfirm(href);
  });

  void document.open(container)
    .then(() => {
      if (location) {
        navigationIntents.set(viewId, 'replace');
        void document.goToLocation(location);
      }
      // 文档打开后加载该材料批注并绘制到覆盖层。
      if (dependencies.annotationRepository) {
        void loadAnnotationsForView(
          { annotationRepository: dependencies.annotationRepository },
          viewId,
        ).catch((error: unknown) => {
          console.error('加载批注失败', error);
        });
      }
    })
    .catch((error: unknown) => {
      console.error('打开阅读文档失败', error);
    });

  return persister;
}

export function registerReaderCommands(
  registry: CommandRegistry,
  dependencies: ReaderCommandDependencies,
): void {
  registry.register(COMMAND_IDS.libraryOpenBook, async (...args: unknown[]) => {
    const material = args[0] as ReadingMaterial | undefined;
    const location = (args[1] as ReadingLocation | null | undefined) ?? null;
    if (!material) {
      throw new Error('打开书籍命令缺少阅读材料参数');
    }
    const viewId = useWorkspaceStore.getState().openView(material.id);
    try {
      const document = await createDocumentForMaterial(dependencies, material);
      if (!document) {
        useWorkspaceStore.getState().closeView(viewId);
        throw new Error(`无法打开阅读材料:${material.title}`);
      }
      useReaderRuntime.getState().setDocument(viewId, document);
      if (location) {
        useWorkspaceStore.getState().setViewLocation(viewId, location);
      }
      await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
    } catch (error) {
      useWorkspaceStore.getState().closeView(viewId);
      throw error;
    }
  });

  registry.register(COMMAND_IDS.readerNextPage, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    navigationIntents.set(viewId, 'replace');
    await useReaderRuntime.getState().getDocument(viewId)?.next();
  });

  registry.register(COMMAND_IDS.readerPrevPage, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    if (!viewId) return;
    navigationIntents.set(viewId, 'replace');
    await useReaderRuntime.getState().getDocument(viewId)?.prev();
  });

  registry.register(COMMAND_IDS.readerGoToHref, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const href = args[1] as string | undefined;
    if (!viewId || !href) return;
    const document = useReaderRuntime.getState().getDocument(viewId);
    if (!document) return;
    navigationIntents.set(viewId, 'push');
    await document.goToHref(href);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
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
    runSearch(viewId, { query, matchCase: useSearchStore.getState().getView(viewId).matchCase });
  });

  registry.register(COMMAND_IDS.readerSearchToggleCase, async (...args: unknown[]) => {
    const viewId = (args[0] as string | undefined) ?? getActiveViewId();
    const queryFromArg = args[1] as string | undefined;
    if (!viewId) return;
    const view = useSearchStore.getState().getView(viewId);
    const matchCase = !view.matchCase;
    useSearchStore.getState().setMatchCase(viewId, matchCase);
    // 用当前输入草稿重搜(若调用方未给草稿则回退到上次已提交查询)。
    runSearch(viewId, { query: queryFromArg ?? view.query, matchCase });
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

  registry.register(COMMAND_IDS.readerCloseView, async (...args: unknown[]) => {
    const viewIdParam = args[0] as string | undefined;
    const targetId = viewIdParam ?? getActiveViewId();
    if (!targetId) return;

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

    const persister = persisters.get(targetId);
    if (persister) {
      await persister.dispose();
      persisters.delete(targetId);
    }
    navigationIntents.delete(targetId);
    // 销毁视图时取消并清理其搜索任务与高亮,避免异步任务写回已销毁视图。
    clearSearch(targetId);
    useSearchStore.getState().close(targetId);
    useReaderRuntime.getState().removeDocument(targetId);
    useWorkspaceStore.getState().closeView(targetId);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

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
    useReaderRuntime.getState().getDocument(viewId)?.applyTypography(effective);
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
    useReaderRuntime.getState().getDocument(viewId)?.applyTypography(effective);
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
    document.applyTypography(effective);
    await dependencies.workspaceRepository.saveState(serializeWorkspaceState());
  });

  registry.register(COMMAND_IDS.readerRestoreView, async (...args: unknown[]) => {
    const viewId = args[0] as string | undefined;
    const material = args[1] as ReadingMaterial | undefined;
    const location = (args[2] as ReadingLocation | null | undefined) ?? null;
    if (!viewId || !material) return;

    const document = await createDocumentForMaterial(dependencies, material);
    if (!document) return;
    useReaderRuntime.getState().setDocument(viewId, document);
    if (location) {
      useWorkspaceStore.getState().setViewLocation(viewId, location);
    }
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

/** 应用关闭时把当前视图位置 flush、取消搜索并关闭渲染器。 */
export async function flushAndCloseAllReaderViews(): Promise<void> {
  for (const persister of persisters.values()) {
    await persister.dispose();
  }
  persisters.clear();
  navigationIntents.clear();
  cancelAllSearches();
  useReaderRuntime.getState().closeAll();
}