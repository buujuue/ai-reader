import { describe, expect, it } from 'vitest';

import {
  COMMAND_IDS,
  CommandRegistry,
  DuplicateCommandError,
  UnknownCommandError,
} from './commandRegistry';

describe('CommandRegistry', () => {
  it('执行已注册的命令并返回处理结果', async () => {
    const registry = new CommandRegistry();
    registry.register(COMMAND_IDS.workbenchTogglePrimarySidebar, () => 'done');

    await expect(registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar)).resolves.toBe(
      'done',
    );
  });

  it('把参数按顺序转发给命令处理器', async () => {
    const registry = new CommandRegistry();
    const received: unknown[] = [];
    registry.register(COMMAND_IDS.workbenchTogglePrimarySidebar, (...args: unknown[]) => {
      received.push(...args);
    });

    await registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar, 'a', 42);

    expect(received).toEqual(['a', 42]);
  });

  it('执行未注册的命令时抛出携带命令 ID 的领域错误', async () => {
    const registry = new CommandRegistry();

    await expect(
      registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar),
    ).rejects.toThrow(UnknownCommandError);
    await expect(
      registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar),
    ).rejects.toThrow('workbench.togglePrimarySidebar');
  });

  it('禁止重复注册同一命令 ID', () => {
    const registry = new CommandRegistry();
    registry.register(COMMAND_IDS.workbenchTogglePrimarySidebar, () => undefined);

    expect(() =>
      registry.register(COMMAND_IDS.workbenchTogglePrimarySidebar, () => undefined),
    ).toThrow(DuplicateCommandError);
  });

  it('注销后命令不可再执行', async () => {
    const registry = new CommandRegistry();
    const dispose = registry.register(
      COMMAND_IDS.workbenchTogglePrimarySidebar,
      () => undefined,
    );

    dispose();

    expect(registry.has(COMMAND_IDS.workbenchTogglePrimarySidebar)).toBe(false);
    await expect(
      registry.execute(COMMAND_IDS.workbenchTogglePrimarySidebar),
    ).rejects.toThrow(UnknownCommandError);
  });
});
