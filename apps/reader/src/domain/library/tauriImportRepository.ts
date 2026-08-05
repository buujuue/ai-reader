import { invoke } from '@tauri-apps/api/core';

import type { TauriInvoke } from '../tauriInvoke';
import type { ImportRepository } from './importRepository';
import type { ReadingMaterial, SourceMetadata, StagedImport } from './material';

export const IMPORT_COMMAND_NAMES = {
  stage: 'stage_import',
  readStaged: 'read_staged_file',
  commit: 'commit_import',
  list: 'list_materials',
  recover: 'recover_imports',
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
    async commitImport(staged: StagedImport, metadata: SourceMetadata): Promise<ReadingMaterial> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.commit, { staged, metadata });
      return assertMaterialShape(raw);
    },
    async listMaterials(): Promise<ReadingMaterial[]> {
      const raw = await invokeFn(IMPORT_COMMAND_NAMES.list);
      return assertMaterialList(raw);
    },
    async recoverImports(): Promise<void> {
      await invokeFn(IMPORT_COMMAND_NAMES.recover);
    },
  };
}

export function createDefaultTauriImportRepository(): ImportRepository {
  return createTauriImportRepository((command, args) => invoke(command, args));
}