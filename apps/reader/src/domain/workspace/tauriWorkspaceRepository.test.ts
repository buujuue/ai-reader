import { describe, expect, it } from 'vitest';

import type { TauriInvoke } from '../tauriInvoke';
import {
  createTauriWorkspaceRepository,
  WORKSPACE_COMMAND_NAMES,
} from './tauriWorkspaceRepository';
import { workspaceRepositoryContract } from './workspaceRepository.contract';
import {
  DEFAULT_EDITOR_GROUP_ID,
  DEFAULT_WORKSPACE_STATE,
  WORKSPACE_STATE_SCHEMA_VERSION,
  type WorkspaceState,
} from './workspaceState';

/** 模拟 Rust 端 typed command 行为：snake_case 命令名、serde camelCase DTO、空库返回默认状态。 */
function createFakeTauriBackend(): TauriInvoke {
  let stored: WorkspaceState | null = null;

  return async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    switch (command) {
      case 'load_workspace_state':
        return stored ?? structuredClone(DEFAULT_WORKSPACE_STATE);
      case 'save_workspace_state': {
        const state = (args as { state?: unknown } | undefined)?.state;
        if (
          typeof state !== 'object' ||
          state === null ||
          typeof (state as WorkspaceState).schemaVersion !== 'number'
        ) {
          throw new Error('invalid workspace state payload');
        }
        stored = structuredClone(state as WorkspaceState);
        return null;
      }
      default:
        throw new Error(`unknown tauri command: ${command}`);
    }
  };
}

describe('WorkspaceRepository 契约 · Tauri Adapter', () => {
  workspaceRepositoryContract(() => createTauriWorkspaceRepository(createFakeTauriBackend()));
});

describe('TauriWorkspaceRepository 边界映射', () => {
  it('使用稳定的 snake_case Tauri 命令名', async () => {
    const calls: string[] = [];
    const invoke: TauriInvoke = async (command) => {
      calls.push(command);
      return structuredClone(DEFAULT_WORKSPACE_STATE);
    };

    const repository = createTauriWorkspaceRepository(invoke);
    await repository.saveState(DEFAULT_WORKSPACE_STATE);
    await repository.loadState();

    expect(calls).toEqual([
      WORKSPACE_COMMAND_NAMES.saveState,
      WORKSPACE_COMMAND_NAMES.loadState,
    ]);
    expect(WORKSPACE_COMMAND_NAMES.saveState).toBe('save_workspace_state');
    expect(WORKSPACE_COMMAND_NAMES.loadState).toBe('load_workspace_state');
  });

  it('保存时把状态放入 serde 期望的 state 参数', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const invoke: TauriInvoke = async (_command, args) => {
      receivedArgs = args;
      return null;
    };

    const repository = createTauriWorkspaceRepository(invoke);
    await repository.saveState(DEFAULT_WORKSPACE_STATE);

    expect(receivedArgs).toEqual({ state: DEFAULT_WORKSPACE_STATE });
  });

  it('后端返回异常结构时拒绝加载', async () => {
    const invoke: TauriInvoke = async () => ({ schemaVersion: 'oops' });

    const repository = createTauriWorkspaceRepository(invoke);

    await expect(repository.loadState()).rejects.toThrow();
  });

  it('加载旧 DTO 时为缺失的侧栏字段使用默认值', async () => {
    const legacyState = structuredClone(DEFAULT_WORKSPACE_STATE) as Partial<WorkspaceState>;
    delete legacyState.tocVisible;
    delete legacyState.activityPanelWidth;
    const invoke: TauriInvoke = async () => legacyState;

    const repository = createTauriWorkspaceRepository(invoke);

    await expect(repository.loadState()).resolves.toMatchObject({
      tocVisible: false,
      activityPanelWidth: 304,
      unfiledMaterialsExpanded: true,
    });
  });

  it('加载旧 DTO 时为缺失的未归类展开状态使用展开默认值', async () => {
    const legacyState = structuredClone(DEFAULT_WORKSPACE_STATE) as Partial<WorkspaceState>;
    delete legacyState.unfiledMaterialsExpanded;
    const invoke: TauriInvoke = async () => legacyState;

    const repository = createTauriWorkspaceRepository(invoke);

    await expect(repository.loadState()).resolves.toMatchObject({
      unfiledMaterialsExpanded: true,
    });
  });

  it('加载旧 DTO 时为缺失的界面面板状态使用关闭默认值', async () => {
    const legacyState = structuredClone(DEFAULT_WORKSPACE_STATE) as Partial<WorkspaceState>;
    delete legacyState.interfacePanelVisible;
    const invoke: TauriInvoke = async () => legacyState;

    const repository = createTauriWorkspaceRepository(invoke);

    await expect(repository.loadState()).resolves.toMatchObject({
      interfacePanelVisible: false,
    });
  });

  it('线格式与 Rust 端锁定的 camelCase DTO 一致', () => {
    expect(WORKSPACE_STATE_SCHEMA_VERSION).toBe(13);
    expect(DEFAULT_WORKSPACE_STATE.activeEditorGroupId).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(JSON.stringify(DEFAULT_WORKSPACE_STATE)).toBe(
      '{"schemaVersion":13,"primarySidebarVisible":true,"tocVisible":false,"interfacePanelVisible":false,"activityPanelWidth":304,"primaryMaterialId":null,"splitDirection":null,"activeEditorGroupId":"group-1","editorGroups":[{"id":"group-1","views":[],"activeViewId":null}],"globalReadingTypography":{"fontFamily":"sansSerif","fontSize":18,"lineHeight":1.6,"margin":48,"gap":7,"flow":"paginated","theme":"light"},"materialTypography":{},"expandedLibraryFolderIds":[],"unfiledMaterialsExpanded":true}',
    );
  });
});
