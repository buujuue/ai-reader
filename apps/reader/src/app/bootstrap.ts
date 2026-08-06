import { CommandRegistry } from '../commands/commandRegistry';
import { createInMemoryImportRepository, addInMemorySource } from '../domain/library/inMemoryImportRepository';
import type { ImportRepository } from '../domain/library/importRepository';
import { createDefaultTauriImportRepository } from '../domain/library/tauriImportRepository';
import { buildEpub } from '../domain/library/epub/zipWriter';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { createDefaultTauriWorkspaceRepository } from '../domain/workspace/tauriWorkspaceRepository';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { registerLibraryCommands } from '../workbench/libraryCommands';
import {
  registerReaderCommands,
  type ReaderCommandDependencies,
} from '../workbench/readerCommands';
import { registerWorkbenchCommands } from '../workbench/workbenchCommands';
import { createInMemoryFilePicker, createTauriFilePicker, type FilePicker } from './filePicker';

export interface AppServices {
  commands: CommandRegistry;
  workspaceRepository: WorkspaceRepository;
  importRepository: ImportRepository;
  filePicker: FilePicker;
}

export interface AppServicesOptions {
  workspaceRepository?: WorkspaceRepository;
  importRepository?: ImportRepository;
  filePicker?: FilePicker;
  viewHostFactory?: ReaderCommandDependencies['viewHostFactory'];
}

/** Tauri WebView 运行时会注入 __TAURI_INTERNALS__;浏览器降级开发时使用内存 Adapter。 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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
    buildEpub({ title: '示例书', author: '示例作者', language: 'zh', withCover: true }),
  );
  return {
    importRepository: createInMemoryImportRepository(sources),
    filePicker: createInMemoryFilePicker(DEMO_SOURCE_PATH),
  };
}

export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const workspaceRepository = options.workspaceRepository ?? createWorkspaceRepository();
  const importServices =
    options.importRepository && options.filePicker
      ? { importRepository: options.importRepository, filePicker: options.filePicker }
      : createImportServices();

  const commands = new CommandRegistry();
  registerWorkbenchCommands(commands, { workspaceRepository });
  registerLibraryCommands(commands, importServices);
  if (options.viewHostFactory) {
    registerReaderCommands(commands, {
      importRepository: importServices.importRepository,
      workspaceRepository,
      viewHostFactory: options.viewHostFactory,
    });
  } else {
    registerReaderCommands(commands, {
      importRepository: importServices.importRepository,
      workspaceRepository,
    });
  }
  return {
    commands,
    workspaceRepository,
    importRepository: importServices.importRepository,
    filePicker: importServices.filePicker,
  };
}
