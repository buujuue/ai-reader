export const COMMAND_IDS = {
  workbenchTogglePrimarySidebar: 'workbench.togglePrimarySidebar',
  workbenchSaveState: 'workbench.saveState',
  libraryImport: 'library.import',
  libraryRefresh: 'library.refresh',
  libraryOpenBook: 'library.openBook',
  readerNextPage: 'reader.nextPage',
  readerPrevPage: 'reader.prevPage',
  readerCloseView: 'reader.closeView',
  readerRestoreView: 'reader.restoreView',
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

export type CommandHandler = (...args: unknown[]) => unknown;

export class UnknownCommandError extends Error {
  constructor(commandId: string) {
    super(`未注册的命令:${commandId}`);
    this.name = 'UnknownCommandError';
  }
}

export class DuplicateCommandError extends Error {
  constructor(commandId: string) {
    super(`命令已注册,不允许重复注册:${commandId}`);
    this.name = 'DuplicateCommandError';
  }
}

/**
 * Command Registry:所有按钮、菜单、键盘和触摸 Adapter 都通过稳定 Command ID
 * 执行用户意图,避免为同一意图实现多套逻辑。
 */
export class CommandRegistry {
  private readonly handlers = new Map<CommandId, CommandHandler>();

  register(commandId: CommandId, handler: CommandHandler): () => void {
    if (this.handlers.has(commandId)) {
      throw new DuplicateCommandError(commandId);
    }
    this.handlers.set(commandId, handler);
    return () => {
      this.handlers.delete(commandId);
    };
  }

  has(commandId: CommandId): boolean {
    return this.handlers.has(commandId);
  }

  async execute(commandId: CommandId, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(commandId);
    if (!handler) {
      throw new UnknownCommandError(commandId);
    }
    return await handler(...args);
  }
}
