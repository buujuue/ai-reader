import { CommandRegistry } from '../commands/commandRegistry';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import { createDefaultTauriWorkspaceRepository } from '../domain/workspace/tauriWorkspaceRepository';
import type { WorkspaceRepository } from '../domain/workspace/workspaceRepository';
import { registerWorkbenchCommands } from '../workbench/workbenchCommands';

export interface AppServices {
  commands: CommandRegistry;
  workspaceRepository: WorkspaceRepository;
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

export function createAppServices(
  workspaceRepository: WorkspaceRepository = createWorkspaceRepository(),
): AppServices {
  const commands = new CommandRegistry();
  registerWorkbenchCommands(commands, { workspaceRepository });
  return { commands, workspaceRepository };
}
