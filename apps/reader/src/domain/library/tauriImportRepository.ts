import { invoke } from '@tauri-apps/api/core';

import type { TauriInvoke } from '../tauriInvoke';
import type { ImportRepository, MarkdownRecoverySnapshot } from './importRepository';
import type { Annotation } from '../annotation/annotation';
import type {
  MaterialOverride,
  ReadingMaterial,
  SourceMetadata,
  StagedImport,
} from './material';
import type {
  VersionMigrationCommitRequest,
  VersionMigrationCommitResult,
  VersionMigrationRestoreResult,
  VersionMigrationSnapshot,
} from './versionMigrationPersistence';
import type { WorkspaceState } from '../workspace/workspaceState';
import { ManagedFileSource, managedFileTypeFromName } from './managedFileSource';

export const IMPORT_COMMAND_NAMES = {
  stage: 'stage_import',
  readStaged: 'read_staged_file',
  discard: 'discard_import',
  commit: 'commit_import',
  list: 'list_materials',
  listTrashed: 'list_trashed',
  trash: 'trash_material',
  restoreMaterial: 'restore_material',
  relink: 'relink_material',
  purge: 'purge_material',
  readManaged: 'read_managed_file',
  managedInfo: 'get_managed_file_info',
  readManagedRange: 'read_managed_file_range',
  recover: 'recover_imports',
  applyMetadata: 'apply_material_metadata',
  setCover: 'set_material_cover',
  removeCover: 'remove_material_cover',
  restore: 'restore_source_metadata',
  readCover: 'read_material_cover',
  saveMarkdown: 'save_markdown',
  writeMarkdownRecovery: 'write_markdown_recovery',
  listMarkdownRecoveries: 'list_markdown_recoveries',
  discardMarkdownRecovery: 'discard_markdown_recovery',
  commitVersionMigration: 'commit_version_migration',
  listVersionMigrationSnapshots: 'list_version_migration_snapshots',
  restoreVersionMigrationSnapshot: 'restore_version_migration_snapshot',
  clearVersionMigrationSnapshot: 'clear_version_migration_snapshot',
} as const;

function assertStagedShape(raw: unknown): StagedImport {
  const candidate = raw as Partial<StagedImport> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.id !== 'string' ||
    typeof candidate.originalFileName !== 'string' ||
    typeof candidate.fingerprint !== 'string'
  ) {
    throw new Error('staged import payload is malformed');
  }
  return {
    id: candidate.id,
    originalFileName: candidate.originalFileName,
    fingerprint: candidate.fingerprint,
  };
}

function assertSourceMetadata(raw: unknown): SourceMetadata {
  const candidate = raw as Partial<SourceMetadata> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.title !== 'string'
  ) {
    throw new Error('source metadata payload is malformed');
  }
  return {
    title: candidate.title,
    author: candidate.author ?? null,
    language: candidate.language ?? null,
  };
}

function assertOverride(raw: unknown): MaterialOverride {
  const candidate = (raw ?? null) as Partial<MaterialOverride> | null;
  return {
    title: candidate?.title ?? null,
    author: candidate?.author ?? null,
    coverSource: candidate?.coverSource ?? null,
  };
}

function assertMaterialShape(raw: unknown): ReadingMaterial {
  const candidate = raw as Partial<ReadingMaterial> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.id !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.fingerprint !== 'string' ||
    typeof candidate.sourceFileName !== 'string'
  ) {
    throw new Error('reading material payload is malformed');
  }
  return {
    id: candidate.id,
    title: candidate.title,
    author: candidate.author ?? null,
    language: candidate.language ?? null,
    fingerprint: candidate.fingerprint,
    sourceFileName: candidate.sourceFileName,
    source: assertSourceMetadata(candidate.source),
    override: assertOverride(candidate.override),
    coverSource: candidate.coverSource ?? null,
    documentVersion: typeof candidate.documentVersion === 'number' ? candidate.documentVersion : 0,
    managedFileAvailable:
      typeof candidate.managedFileAvailable === 'boolean' ? candidate.managedFileAvailable : true,
  };
}

function assertMaterialList(raw: unknown): ReadingMaterial[] {
  if (!Array.isArray(raw)) {
    throw new Error('materials payload is not an array');
  }
  return raw.map(assertMaterialShape);
}

interface ManagedFileInfo {
  name: string;
  size: number;
}

function assertManagedFileInfo(raw: unknown): ManagedFileInfo {
  const candidate = raw as Partial<ManagedFileInfo> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.name !== 'string' ||
    typeof candidate.size !== 'number' ||
    !Number.isSafeInteger(candidate.size) ||
    candidate.size < 0
  ) {
    throw new Error('managed file info payload is malformed');
  }
  return { name: candidate.name, size: candidate.size };
}

function assertAnnotationList(raw: unknown): Annotation[] {
  if (!Array.isArray(raw)) throw new Error('version migration annotations payload is not an array');
  return raw as Annotation[];
}

function assertWorkspaceState(raw: unknown): WorkspaceState {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('version migration workspace payload is malformed');
  }
  return raw as WorkspaceState;
}

function assertVersionMigrationSnapshot(raw: unknown): VersionMigrationSnapshot {
  const candidate = raw as Partial<VersionMigrationSnapshot> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.id !== 'string' ||
    typeof candidate.materialId !== 'string' ||
    typeof candidate.sourceFingerprint !== 'string' ||
    typeof candidate.targetFingerprint !== 'string' ||
    typeof candidate.createdAt !== 'number' ||
    !['available', 'corrupt'].includes(candidate.status ?? '')
  ) {
    throw new Error('version migration snapshot payload is malformed');
  }
  return candidate as VersionMigrationSnapshot;
}

function assertMarkdownRecovery(raw: unknown): MarkdownRecoverySnapshot {
  const candidate = raw as Partial<MarkdownRecoverySnapshot> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.materialId !== 'string' ||
    (candidate.content !== null && typeof candidate.content !== 'string') ||
    (candidate.baseDocumentVersion !== null && typeof candidate.baseDocumentVersion !== 'number') ||
    (candidate.updatedAt !== null && typeof candidate.updatedAt !== 'number') ||
    !['available', 'conflict', 'corrupt'].includes(candidate.status ?? '')
  ) {
    throw new Error('markdown recovery payload is malformed');
  }
  return candidate as MarkdownRecoverySnapshot;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function createTauriImportRepository(invokeFn: TauriInvoke): ImportRepository {
  return {
    async stageImport(sourcePath: string): Promise<StagedImport> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.stage, { sourcePath });
      return assertStagedShape(raw);
    },
    async readStagedFile(staged: StagedImport): Promise<Uint8Array> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.readStaged, { staged });
      if (typeof raw !== 'string') {
        throw new Error('staged file bytes payload is not a string');
      }
      return base64ToBytes(raw);
    },
    async discardImport(staged: StagedImport): Promise<void> {
      await invokeFn(IMPORT_COMMAND_NAMES.discard, { staged });
    },
    async commitImport(staged: StagedImport, metadata: SourceMetadata): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.commit, { staged, metadata });
      return assertMaterialShape(raw);
    },
    async listMaterials(): Promise<ReadingMaterial[]> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.list);
      return assertMaterialList(raw);
    },
    async listTrashed(): Promise<ReadingMaterial[]> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.listTrashed);
      return assertMaterialList(raw);
    },
    async trashMaterial(materialId: string): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.trash, { materialId });
      return assertMaterialShape(raw);
    },
    async restoreMaterial(materialId: string): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.restoreMaterial, { materialId });
      return assertMaterialShape(raw);
    },
    async relinkMaterial(materialId: string, staged: StagedImport): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.relink, { materialId, staged });
      return assertMaterialShape(raw);
    },
    async purgeMaterial(materialId: string): Promise<void> {
      await invokeFn(IMPORT_COMMAND_NAMES.purge, { materialId });
    },
    async readManagedFile(materialId: string): Promise<Uint8Array> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.readManaged, { materialId });
      if (typeof raw !== 'string') {
        throw new Error('managed file bytes payload is not a string');
      }
      return base64ToBytes(raw);
    },
    async openManagedFileSource(materialId: string): Promise<ManagedFileSource> {
      const info = assertManagedFileInfo(
        await invokeFn(IMPORT_COMMAND_NAMES.managedInfo, { materialId }),
      );
      return new ManagedFileSource(
        {
          name: info.name,
          size: info.size,
          type: managedFileTypeFromName(info.name),
        },
        async (offset, length) => {
          const raw = await invokeFn(IMPORT_COMMAND_NAMES.readManagedRange, {
            materialId,
            offset,
            length,
          });
          if (typeof raw !== 'string') {
            throw new Error('managed file range bytes payload is not a string');
          }
          return base64ToBytes(raw);
        },
      );
    },
    async recoverImports(): Promise<void> {
      await invokeFn(IMPORT_COMMAND_NAMES.recover);
    },
    async applyMaterialMetadata(
      materialId: string,
      title: string | null,
      author: string | null,
    ): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.applyMetadata, {
        materialId,
        title,
        author,
      });
      return assertMaterialShape(raw);
    },
    async setMaterialCover(materialId: string, sourcePath: string): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.setCover, { materialId, sourcePath });
      return assertMaterialShape(raw);
    },
    async removeMaterialCover(materialId: string): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.removeCover, { materialId });
      return assertMaterialShape(raw);
    },
    async restoreSourceMetadata(materialId: string): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.restore, { materialId });
      return assertMaterialShape(raw);
    },
    async readCover(materialId: string): Promise<Uint8Array | null> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.readCover, { materialId });
      if (raw === null) {
        return null;
      }
      if (typeof raw !== 'string') {
        throw new Error('cover bytes payload is not a string');
      }
      return base64ToBytes(raw);
    },
    async commitVersionMigration(
      request: VersionMigrationCommitRequest,
    ): Promise<VersionMigrationCommitResult> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.commitVersionMigration, { request });
      const candidate = raw as Partial<VersionMigrationCommitResult> | null;
      if (typeof candidate !== 'object' || candidate === null || typeof candidate.snapshotId !== 'string') {
        throw new Error('version migration commit payload is malformed');
      }
      return {
        snapshotId: candidate.snapshotId,
        material: assertMaterialShape(candidate.material),
      };
    },
    async listVersionMigrationSnapshots(): Promise<VersionMigrationSnapshot[]> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.listVersionMigrationSnapshots);
      if (!Array.isArray(raw)) throw new Error('version migration snapshots payload is not an array');
      return raw.map(assertVersionMigrationSnapshot);
    },
    async restoreVersionMigrationSnapshot(
      snapshotId: string,
    ): Promise<VersionMigrationRestoreResult> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.restoreVersionMigrationSnapshot, { snapshotId });
      const candidate = raw as Partial<VersionMigrationRestoreResult> | null;
      if (typeof candidate !== 'object' || candidate === null) {
        throw new Error('version migration restore payload is malformed');
      }
      return {
        material: assertMaterialShape(candidate.material),
        annotations: assertAnnotationList(candidate.annotations),
        workspaceState: assertWorkspaceState(candidate.workspaceState),
      };
    },
    async clearVersionMigrationSnapshot(snapshotId: string): Promise<void> {
      await invokeFn(IMPORT_COMMAND_NAMES.clearVersionMigrationSnapshot, { snapshotId });
    },
    async saveMarkdown(materialId: string, content: string): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.saveMarkdown, { materialId, content });
      return assertMaterialShape(raw);
    },
    async writeMarkdownRecovery(materialId, content, baseDocumentVersion): Promise<void> {
      await invokeFn(IMPORT_COMMAND_NAMES.writeMarkdownRecovery, {
        materialId,
        content,
        baseDocumentVersion,
      });
    },
    async listMarkdownRecoveries(): Promise<MarkdownRecoverySnapshot[]> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.listMarkdownRecoveries);
      if (!Array.isArray(raw)) {
        throw new Error('markdown recoveries payload is not an array');
      }
      return raw.map(assertMarkdownRecovery);
    },
    async discardMarkdownRecovery(materialId): Promise<void> {
      await invokeFn(IMPORT_COMMAND_NAMES.discardMarkdownRecovery, { materialId });
    },
  };
}

export function createDefaultTauriImportRepository(): ImportRepository {
  return createTauriImportRepository((command, args) => invoke(command, args));
}
