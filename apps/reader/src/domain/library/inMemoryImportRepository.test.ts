import { describe, it } from 'vitest';

import { createInMemoryFilePicker, type FilePicker } from '../../app/filePicker';
import { importRepositoryContract, type ImportContractHarness } from './importRepository.contract';
import { importBatchContract, type ImportBatchContractHarness } from './importBatch.contract';
import {
  addInMemorySource,
  createInMemoryImportRepository,
} from './inMemoryImportRepository';

function createInMemoryHarness(): ImportContractHarness {
  let sources = new Map<string, Uint8Array>();
  let repository = createInMemoryImportRepository(sources);

  return {
    createRepository() {
      sources = new Map<string, Uint8Array>();
      repository = createInMemoryImportRepository(sources);
      return repository;
    },
    async stage(name, bytes) {
      addInMemorySource(sources, name, bytes);
      return repository.stageImport(name);
    },
  };
}

function createInMemoryBatchHarness(): ImportBatchContractHarness {
  let sources = new Map<string, Uint8Array>();
  let repository = createInMemoryImportRepository(sources);

  return {
    createRepository() {
      sources = new Map<string, Uint8Array>();
      repository = createInMemoryImportRepository(sources);
      return repository;
    },
    registerSource(path, bytes) {
      addInMemorySource(sources, path, bytes);
    },
    createPicker(paths) {
      return createPicker(paths);
    },
  };
}

function createPicker(paths: string[] | null): FilePicker {
  return { async pickEpubs() { return paths ? [...paths] : null; } };
}

describe('ImportRepository 契约 · 内存 Adapter', () => {
  importRepositoryContract(createInMemoryHarness());
});

describe('批量导入契约 · 内存 Adapter', () => {
  importBatchContract(createInMemoryBatchHarness());
});