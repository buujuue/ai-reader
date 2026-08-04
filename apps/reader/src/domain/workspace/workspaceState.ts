export const WORKSPACE_STATE_SCHEMA_VERSION = 1;

export interface WorkspaceState {
  schemaVersion: number;
  primarySidebarVisible: boolean;
}

export const DEFAULT_WORKSPACE_STATE: WorkspaceState = Object.freeze({
  schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
  primarySidebarVisible: true,
});
