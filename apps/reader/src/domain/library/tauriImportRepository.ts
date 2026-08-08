import { invoke } from '@tauri-apps/api/core';

import type { TauriInvoke } from '../tauriInvoke';
import type { ImportRepository } from './importRepository';
import type {
  MaterialOverride,
  ReadingMaterial,
  SourceMetadata,
  StagedImport,
} from './material';

export const IMPORT_COMMAND_NAMES = {
  stage: 'stage_import',
  readStaged: 'read_staged_file',
  discard: 'discard_import',
  commit: 'commit_import',
  list: 'list_materials',
  readManaged: 'read_managed_file',
  recover: 'recover_imports',
  applyMetadata: 'apply_material_metadata',
  setCover: 'set_material_cover',
  removeCover: 'remove_material_cover',
  restore: 'restore_source_metadata',
  readCover: 'read_material_cover',
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
  };
}

function assertMaterialList(raw: unknown): ReadingMaterial[] {
  if (!Array.isArray(raw)) {
    throw new Error('materials payload is not an array');
  }
  return raw.map(assertMaterialShape);
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
    async readManagedFile(materialId: string): Promise<Uint8Array> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.readManaged, { materialId });
      if (typeof raw !== 'string') {
        throw new Error('managed file bytes payload is not a string');
      }
      return base64ToBytes(raw);
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
  };
}

export function createDefaultTauriImportRepository(): ImportRepository {
  return createTauriImportRepository((command, args) => invoke(command, args));
}