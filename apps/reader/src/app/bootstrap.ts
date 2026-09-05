import { CommandRegistry } from '../commands/commandRegistry';
import {
  addInMemorySource,
  createInMemoryImportRepository,
  type InMemoryImportRepository,
} from '../domain/library/inMemoryImportRepository';
import type { ImportRepository } from '../domain/library/importRepository';
import { createDefaultTauriImportRepository } from '../domain/library/tauriImportRepository';
import type { LibraryFolderRepository } from '../domain/library/libraryFolderRepository';
import type { InMemoryDeletionTransaction } from '../domain/library/libraryFolderRepository';
import { createInMemoryLibraryFolderRepository } from '../domain/library/inMemoryLibraryFolderRepository';
import { createDefaultTauriLibraryFolderRepository } from '../domain/library/tauriLibraryFolderRepository';
import { buildEpub } from '../domain/library/epub/zipWriter';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import { createLocalStorageAnnotationRepository } from '../domain/annotation/localStorageAnnotationRepository';
import { createDefaultTauriAnnotationRepository } from '../domain/annotation/tauriAnnotationRepository';
import type { AnnotationExportWriter } from '../domain/annotation/annotationExportWriter';
import { createInMemoryAnnotationExportWriter } from '../domain/annotation/inMemoryAnnotationExportWriter';
import { createDefaultTauriAnnotationExportWriter } from '../domain/annotation/tauriAnnotationExportWriter';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { createDefaultTauriWorkspaceRepository } from '../domain/workspace/tauriWorkspaceRepository';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { registerAnnotationCommands } from '../workbench/annotationCommands';
import { registerAnnotationExportCommands } from '../workbench/annotationExportCommands';
import { registerLibraryCommands } from '../workbench/libraryCommands';
import { registerMarkdownCommands } from '../workbench/markdownCommands';
import {
  applyWorkbenchThemeToOpenReflowableViews,
  registerReaderCommands,
  flushReaderPositions,
  flushAndCloseAllReaderViews,
  reloadMaterialViews,
  invalidateReaderRuntimeMaterial,
  restoreReaderViewRuntime,
  type ReaderCommandDependencies,
  suspendReaderViewRuntime,
} from '../workbench/readerCommands';
import { ReaderRuntimeCache } from '../workbench/readerRuntimeCache';
import { registerWorkbenchCommands } from '../workbench/workbenchCommands';
import { registerBackupCommands } from '../workbench/backupCommands';
import type { BackupRepository } from '../domain/library/backupRepository';
import { createDefaultTauriBackupRepository } from '../domain/library/tauriBackupRepository';
import { createUnsupportedBackupRepository } from '../domain/library/backupRepository';
import { useAnnotationStore } from '../workbench/annotationStore';
import { useWorkbenchAppearanceStore } from '../workbench/appearanceStore';
import { createInMemoryFilePicker, createTauriFilePicker, type FilePicker } from './filePicker';
import {
  applyWorkbenchAppearanceToDocument,
  createLocalStorageWorkbenchAppearancePreferences,
  DEFAULT_WORKBENCH_APPEARANCE,
  normalizeWorkbenchAppearance,
  type WorkbenchAppearancePreferences,
} from './workbenchAppearance';
import {
  createDefaultExternalUrlOpener,
  type ExternalUrlOpener,
} from './externalUrlOpener';
import type { PdfJsLib } from '../domain/reader/pdf/pdfLibrary';
import type { PdfPageRasterizer } from '../domain/reader/pdf/pdfPageRenderer';
import {
  createUnavailableEpubNativeAccelerator,
  type EpubNativeAccelerator,
} from '../domain/reader/nativeEpub';
import { createDefaultTauriEpubNativeAccelerator } from '../domain/reader/tauriEpubNative';
import {
  createEpubDerivedTocCache,
  type EpubDerivedTocCache,
} from '../domain/reader/derivedToc';
import { createDefaultTauriEpubDerivedTocCache } from '../domain/reader/tauriDerivedTocCache';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { isAndroidWebView } from './platform';
import {
  createInMemoryBackupDestinationPicker,
  createTauriBackupDestinationPicker,
  type BackupDestinationPicker,
} from './backupDestinationPicker';
import {
  createInMemoryBackupSourcePicker,
  createTauriBackupSourcePicker,
  type BackupSourcePicker,
} from './backupSourcePicker';
import {
  createInMemoryAnnotationExportDestinationPicker,
  createTauriAnnotationExportDestinationPicker,
  type AnnotationExportDestinationPicker,
} from './annotationExportDestinationPicker';

export interface WindowCloseRequestedEvent {
  preventDefault: () => void;
}

export interface WindowLifecycle {
  onCloseRequested: (
    handler: (event: WindowCloseRequestedEvent) => void | Promise<void>,
  ) => Promise<() => void>;
  destroy: () => Promise<void>;
}

export interface AndroidBackButtonEvent {
  canGoBack: boolean;
}

export interface AndroidBackButton {
  onBackButtonPress: (
    handler: (event: AndroidBackButtonEvent) => void | Promise<void>,
  ) => Promise<() => void>;
}

export interface AppServices {
  commands: CommandRegistry;
  workspaceRepository: WorkspaceRepository;
  importRepository: ImportRepository;
  libraryFolderRepository: LibraryFolderRepository;
  annotationRepository: AnnotationRepository;
  annotationExportDestinationPicker: AnnotationExportDestinationPicker;
  annotationExportWriter: AnnotationExportWriter;
  backupRepository: BackupRepository;
  backupDestinationPicker: BackupDestinationPicker;
  backupSourcePicker: BackupSourcePicker;
  filePicker: FilePicker;
  externalUrlOpener: ExternalUrlOpener;
  windowLifecycle: WindowLifecycle | null;
  androidBackButton: AndroidBackButton | null;
  epubNativeAccelerator: EpubNativeAccelerator;
  appearancePreferences: WorkbenchAppearancePreferences;
}

export interface AppServicesOptions {
  workspaceRepository?: WorkspaceRepository;
  importRepository?: ImportRepository;
  libraryFolderRepository?: LibraryFolderRepository;
  annotationRepository?: AnnotationRepository;
  annotationExportDestinationPicker?: AnnotationExportDestinationPicker;
  annotationExportWriter?: AnnotationExportWriter;
  backupRepository?: BackupRepository;
  backupDestinationPicker?: BackupDestinationPicker;
  backupSourcePicker?: BackupSourcePicker;
  filePicker?: FilePicker;
  viewHostFactory?: ReaderCommandDependencies['viewHostFactory'];
  externalUrlOpener?: ExternalUrlOpener;
  /** 可注入的 PDF.js 库(测试用);缺省由 PdfBookDocument/PdfInspector 懒加载真实引擎。 */
  pdfLib?: PdfJsLib;
  /** 可注入的页面光栅化函数(测试用)。 */
  pdfRasterize?: PdfPageRasterizer;
  epubNativeAccelerator?: EpubNativeAccelerator;
  /** 可注入的 EPUB 推导目录缓存;Tauri 默认落到 Rust 私有文件缓存。 */
  epubDerivedTocCache?: EpubDerivedTocCache;
  windowLifecycle?: WindowLifecycle | null;
  androidBackButton?: AndroidBackButton | null;
  /** 可注入的有限 Reader Runtime 缓存；生产按窗口指针/宽度自动选择预算。 */
  readerRuntimeCache?: ReaderRuntimeCache;
  appearancePreferences?: WorkbenchAppearancePreferences;
}

/** Tauri WebView 运行时会注入 __TAURI_INTERNALS__;浏览器降级开发时使用内存 Adapter。 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function createWindowLifecycle(): WindowLifecycle | null {
  if (!isTauriRuntime()) return null;
  const appWindow = getCurrentWindow();
  return {
    onCloseRequested: (handler) => appWindow.onCloseRequested(handler),
    destroy: () => appWindow.destroy(),
  };
}

function createAndroidBackButton(): AndroidBackButton | null {
  if (
    !isTauriRuntime() ||
    !isAndroidWebView()
  ) {
    return null;
  }

  return {
    onBackButtonPress: async (handler) => {
      const listener = await onBackButtonPress(handler);
      return () => {
        void listener.unregister();
      };
    },
  };
}

export function createWorkspaceRepository(): WorkspaceRepository {
  return isTauriRuntime()
    ? createDefaultTauriWorkspaceRepository()
    : createInMemoryWorkspaceRepository();
}

const DEMO_SOURCE_PATH = '演示书/示例书.epub';

export function createImportServices(): {
  importRepository: ImportRepository;
  filePicker: FilePicker;
} {
  if (isTauriRuntime()) {
    return {
      importRepository: createDefaultTauriImportRepository(),
      filePicker: createTauriFilePicker(),
    };
  }

  const sources = new Map<string, Uint8Array>();
  addInMemorySource(
    sources,
    DEMO_SOURCE_PATH,
    buildEpub({ title: '示例书', author: '示例作者', language: 'zh', withCover: true, withImage: true }),
  );
  return {
    importRepository: createInMemoryImportRepository(sources),
    filePicker: createInMemoryFilePicker([DEMO_SOURCE_PATH]),
  };
}

export function createLibraryFolderRepository(
  prepareDeleteSubtree?: (folderIds: readonly string[]) => InMemoryDeletionTransaction,
): LibraryFolderRepository {
  return isTauriRuntime()
    ? createDefaultTauriLibraryFolderRepository()
    : createInMemoryLibraryFolderRepository(
        [],
        prepareDeleteSubtree ? { prepareDeleteSubtree } : {},
      );
}

export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const workspaceRepository = options.workspaceRepository ?? createWorkspaceRepository();
  const appearancePreferences =
    options.appearancePreferences ?? createLocalStorageWorkbenchAppearancePreferences();
  let appearance = DEFAULT_WORKBENCH_APPEARANCE;
  try {
    appearance = normalizeWorkbenchAppearance(appearancePreferences.load());
  } catch (error) {
    console.error('读取工作台外观失败', error);
  }
  useWorkbenchAppearanceStore.getState().hydrate(appearance);
  applyWorkbenchAppearanceToDocument(appearance);
  const importServices =
    options.importRepository && options.filePicker
      ? { importRepository: options.importRepository, filePicker: options.filePicker }
      : createImportServices();
  const inMemoryImportRepository = importServices.importRepository as Partial<InMemoryImportRepository>;
  const prepareDeleteSubtree = typeof inMemoryImportRepository.prepareClearMaterialFolderAssignments === 'function'
    ? inMemoryImportRepository.prepareClearMaterialFolderAssignments.bind(inMemoryImportRepository)
    : undefined;
  const libraryFolderRepository = options.libraryFolderRepository ?? createLibraryFolderRepository(prepareDeleteSubtree);
  const annotationRepository =
    options.annotationRepository ??
    (isTauriRuntime()
      ? createDefaultTauriAnnotationRepository()
      : createLocalStorageAnnotationRepository());
  const annotationExportDestinationPicker =
    options.annotationExportDestinationPicker ??
    (isTauriRuntime()
      ? createTauriAnnotationExportDestinationPicker()
      : createInMemoryAnnotationExportDestinationPicker());
  const annotationExportWriter =
    options.annotationExportWriter ??
    (isTauriRuntime()
      ? createDefaultTauriAnnotationExportWriter()
      : createInMemoryAnnotationExportWriter());
  const externalUrlOpener = options.externalUrlOpener ?? createDefaultExternalUrlOpener();
  const backupRepository =
    options.backupRepository ??
    (isTauriRuntime() ? createDefaultTauriBackupRepository() : createUnsupportedBackupRepository());
  const backupDestinationPicker =
    options.backupDestinationPicker ??
    (isTauriRuntime()
      ? createTauriBackupDestinationPicker()
      : createInMemoryBackupDestinationPicker());
  const backupSourcePicker =
    options.backupSourcePicker ??
    (isTauriRuntime() ? createTauriBackupSourcePicker() : createInMemoryBackupSourcePicker());
  const windowLifecycle =
    options.windowLifecycle !== undefined
      ? options.windowLifecycle
      : createWindowLifecycle();
  const androidBackButton =
    options.androidBackButton !== undefined
      ? options.androidBackButton
      : createAndroidBackButton();
  const epubNativeAccelerator =
    options.epubNativeAccelerator ??
    (isTauriRuntime()
      ? createDefaultTauriEpubNativeAccelerator()
      : createUnavailableEpubNativeAccelerator());
  const epubDerivedTocCache =
    options.epubDerivedTocCache ??
    (isTauriRuntime()
      ? createDefaultTauriEpubDerivedTocCache()
      : createEpubDerivedTocCache());
  const readerRuntimeCache = options.readerRuntimeCache ?? new ReaderRuntimeCache();

  const commands = new CommandRegistry();
  const readerCommandDependencies: ReaderCommandDependencies = {
    importRepository: importServices.importRepository,
    workspaceRepository,
    annotationRepository,
    ...(options.viewHostFactory ? { viewHostFactory: options.viewHostFactory } : {}),
    externalUrlOpener,
    pdfLib: options.pdfLib,
    pdfRasterize: options.pdfRasterize,
    epubNativeAccelerator,
    epubDerivedTocCache,
    readerRuntimeCache,
  };
  registerWorkbenchCommands(commands, {
    workspaceRepository,
    annotationRepository,
    appearancePreferences,
    onAppearanceThemeChanged: applyWorkbenchThemeToOpenReflowableViews,
  });
  registerBackupCommands(commands, {
    backupRepository,
    destinationPicker: backupDestinationPicker,
    sourcePicker: backupSourcePicker,
    flushReaderPositions,
    closeReaderRuntimes: flushAndCloseAllReaderViews,
    reloadApplication: isTauriRuntime() ? () => window.location.reload() : undefined,
  });
  registerLibraryCommands(commands, {
    ...importServices,
    libraryFolderRepository,
    pdfLib: options.pdfLib,
    annotationRepository,
    workspaceRepository,
    syncVersionMigrationState: !isTauriRuntime(),
    reloadMaterialViews: (materialId) => reloadMaterialViews(readerCommandDependencies, materialId),
    invalidateMaterialRuntime: invalidateReaderRuntimeMaterial,
    ...(isTauriRuntime() ? { reloadApplication: () => window.location.reload() } : {}),
    ...(options.viewHostFactory ? { viewHostFactory: options.viewHostFactory } : {}),
  });
  registerAnnotationCommands(commands, { annotationRepository });
  registerAnnotationExportCommands(commands, {
    annotationRepository,
    destinationPicker: annotationExportDestinationPicker,
    writer: annotationExportWriter,
  });
  registerMarkdownCommands(commands, {
    importRepository: importServices.importRepository,
    workspaceRepository,
    invalidateMaterialRuntime: invalidateReaderRuntimeMaterial,
    reloadMaterialViews: (materialId) => reloadMaterialViews(readerCommandDependencies, materialId),
    suspendReaderView: (viewId) => suspendReaderViewRuntime(readerCommandDependencies, viewId),
    restoreReaderView: (viewId) => restoreReaderViewRuntime(readerCommandDependencies, viewId).then(() => undefined),
    ...(options.viewHostFactory ? { viewHostFactory: options.viewHostFactory } : {}),
  });
  // 暴露批注 Store 到 window,供真实浏览器验收脚本读取(仅开发/测试用)。
  if (typeof window !== 'undefined') {
    (window as unknown as { __annotationStore: unknown }).__annotationStore = useAnnotationStore;
  }
  registerReaderCommands(commands, readerCommandDependencies);
  return {
    commands,
    workspaceRepository,
    importRepository: importServices.importRepository,
    libraryFolderRepository,
    annotationRepository,
    annotationExportDestinationPicker,
    annotationExportWriter,
    backupRepository,
    backupDestinationPicker,
    backupSourcePicker,
    filePicker: importServices.filePicker,
    externalUrlOpener,
    windowLifecycle,
    androidBackButton,
    epubNativeAccelerator,
    appearancePreferences,
  };
}
