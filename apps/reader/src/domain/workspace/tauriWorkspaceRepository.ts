import { invoke } from '@tauri-apps/api/core';

import { isReadingLocation } from '../reader/readingLocation';
import {
  createNavigationHistory,
  type NavigationHistory,
} from '../reader/navigationHistory';
import {
  DEFAULT_READING_TYPOGRAPHY,
  isReadingTypography,
  isTypographyOverride,
} from '../reader/typography';
import type { TauriInvoke } from '../tauriInvoke';
import type { WorkspaceRepository } from './workspaceRepository';
import {
  DEFAULT_EDITOR_GROUP_ID,
  DEFAULT_WORKSPACE_STATE,
  WORKSPACE_STATE_SCHEMA_VERSION,
  type EditorGroupState,
  type ReadingViewState,
  type WorkspaceState,
} from './workspaceState';

export const WORKSPACE_COMMAND_NAMES = {
  loadState: 'load_workspace_state',
  saveState: 'save_workspace_state',
} as const;

function isNavigationHistory(value: unknown): value is NavigationHistory {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<NavigationHistory>;
  if (!Array.isArray(candidate.positions) || typeof candidate.index !== 'number') {
    return false;
  }
  if (!candidate.positions.every((position) => isReadingLocation(position))) {
    return false;
  }
  return candidate.index >= -1 && candidate.index < candidate.positions.length;
}

function normalizeHistory(raw: unknown): NavigationHistory {
  if (isNavigationHistory(raw)) {
    return raw;
  }
  return createNavigationHistory();
}

function assertViewShape(raw: unknown): ReadingViewState {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('reading view payload is not an object');
  }
  const candidate = raw as Partial<ReadingViewState>;
  if (typeof candidate.id !== 'string' || typeof candidate.materialId !== 'string') {
    throw new Error('reading view payload is malformed');
  }
  if (candidate.location !== null && candidate.location !== undefined && !isReadingLocation(candidate.location)) {
    throw new Error('reading view location payload is malformed');
  }
  return {
    id: candidate.id,
    materialId: candidate.materialId,
    location: candidate.location ?? null,
    history: normalizeHistory(candidate.history),
    sourceMode: candidate.sourceMode ?? false,
  };
}

function assertEditorGroupShape(raw: unknown): EditorGroupState {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('editor group payload is not an object');
  }
  const candidate = raw as Partial<EditorGroupState>;
  if (typeof candidate.id !== 'string' || !Array.isArray(candidate.views)) {
    throw new Error('editor group payload is malformed');
  }
  if (candidate.activeViewId !== null && typeof candidate.activeViewId !== 'string') {
    throw new Error('editor group active view payload is malformed');
  }
  return {
    id: candidate.id,
    views: candidate.views.map(assertViewShape),
    activeViewId: candidate.activeViewId ?? null,
  };
}

function assertWorkspaceStateShape(raw: unknown): WorkspaceState {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('workspace state payload is not an object');
  }
  const candidate = raw as Partial<WorkspaceState>;
  if (
    typeof candidate.schemaVersion !== 'number' ||
    typeof candidate.primarySidebarVisible !== 'boolean' ||
    (typeof candidate.activeEditorGroupId !== 'string' &&
      candidate.activeEditorGroupId !== undefined)
  ) {
    throw new Error('workspace state payload is malformed');
  }
  // 版本 1 的载荷没有 editorGroups,迁移为默认单组,保证旧数据可继续加载。
  const editorGroups = Array.isArray(candidate.editorGroups)
    ? candidate.editorGroups.map(assertEditorGroupShape)
    : structuredClone(DEFAULT_WORKSPACE_STATE.editorGroups);
  // 版本 4 引入排版设置;旧载荷缺失时回退到全局默认,保证旧数据可继续加载。
  const globalReadingTypography = isReadingTypography(candidate.globalReadingTypography)
    ? candidate.globalReadingTypography
    : DEFAULT_READING_TYPOGRAPHY;
  const materialTypography: Record<string, unknown> = 
    typeof candidate.materialTypography === 'object' && candidate.materialTypography !== null
      ? (candidate.materialTypography as Record<string, unknown>)
      : {};
  const materialOverrideEntries = Object.entries(materialTypography)
    .filter((entry): entry is [string, unknown] => isTypographyOverride(entry[1]))
    .map(([materialId, override]) => [materialId, override]);
  return {
    schemaVersion: candidate.schemaVersion,
    primarySidebarVisible: candidate.primarySidebarVisible,
    activeEditorGroupId: candidate.activeEditorGroupId ?? DEFAULT_EDITOR_GROUP_ID,
    editorGroups,
    globalReadingTypography,
    materialTypography: Object.fromEntries(materialOverrideEntries),
  };
}

export function createTauriWorkspaceRepository(invoke: TauriInvoke): WorkspaceRepository {
  return {
    async loadState(): Promise<WorkspaceState> {
      const raw = await invoke(WORKSPACE_COMMAND_NAMES.loadState);
      return assertWorkspaceStateShape(raw);
    },
    async saveState(state: WorkspaceState): Promise<void> {
      await invoke(WORKSPACE_COMMAND_NAMES.saveState, { state });
    },
  };
}

export function createDefaultTauriWorkspaceRepository(): WorkspaceRepository {
  return createTauriWorkspaceRepository((command, args) => invoke(command, args));
}

export { WORKSPACE_STATE_SCHEMA_VERSION };