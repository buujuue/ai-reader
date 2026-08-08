import { describe, it } from 'vitest';

import { createInMemoryFilePicker, type FilePicker } from '../../app/filePicker';
import { importRepositoryContract, type ImportContractHarness } from './importRepository.contract';
import { importBatchContract, type ImportBatchContractHarness } from './importBatch.contract';
import { metadataRepositoryContract } from './metadataRepository.contract';
import { recycleBinRepositoryContract } from './recycleBinRepository.contract';
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
    registerCoverSource(name, bytes) {
      addInMemorySource(sources, name, bytes);
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
  return {
    async pickBooks() {
      return paths ? [...paths] : null;
    },
    async pickImage() {
      return null;
    },
  };
}

describe('ImportRepository 契约 · 内存 Adapter', () => {
  importRepositoryContract(createInMemoryHarness());
});

describe('元数据覆盖契约 · 内存 Adapter', () => {
  metadataRepositoryContract(createInMemoryHarness());
});

describe('回收站契约 · 内存 Adapter', () => {
  recycleBinRepositoryContract(createInMemoryHarness());
});

describe('批量导入契约 · 内存 Adapter', () => {
  importBatchContract(createInMemoryBatchHarness());
});