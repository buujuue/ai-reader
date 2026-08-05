import { describe, it } from 'vitest';

import { importRepositoryContract, type ImportContractHarness } from './importRepository.contract';
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

describe('ImportRepository 契约 · 内存 Adapter', () => {
  importRepositoryContract(createInMemoryHarness());
});