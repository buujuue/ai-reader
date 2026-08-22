import type { Annotation } from '../annotation/annotation';
import type { WorkspaceState } from '../workspace/workspaceState';
import type { CoverAsset, ReadingMaterial, SourceMetadata, StagedImport } from './material';

/** 版本迁移确认后一次性提交到 Rust 的完整载荷。 */
export interface VersionMigrationCommitRequest {
  materialId: string;
  staged: StagedImport;
  metadata: SourceMetadata;
  sourceCover?: CoverAsset | null;
  expectedSourceFingerprint: string;
  expectedTargetFingerprint: string;
  annotations: readonly Annotation[];
  workspaceState: WorkspaceState;
  /** 仅内存 Adapter 用于验证恢复快照;Rust 从一致 SQLite 快照读取旧数据。 */
  previousAnnotations: readonly Annotation[];
  previousWorkspaceState: WorkspaceState;
}

export interface VersionMigrationCommitResult {
  material: ReadingMaterial;
  snapshotId: string;
}

export type VersionMigrationSnapshotStatus = 'available' | 'corrupt';

export interface VersionMigrationSnapshot {
  id: string;
  materialId: string;
  sourceFingerprint: string;
  targetFingerprint: string;
  createdAt: number;
  status: VersionMigrationSnapshotStatus;
}

export interface VersionMigrationRestoreResult {
  material: ReadingMaterial;
  annotations: Annotation[];
  workspaceState: WorkspaceState;
}
