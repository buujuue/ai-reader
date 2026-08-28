import { describe } from 'vitest';

import { libraryFolderRepositoryContract } from './libraryFolderRepository.contract';
import { createInMemoryLibraryFolderRepository } from './inMemoryLibraryFolderRepository';

describe('LibraryFolderRepository 契约 · 内存 Adapter', () => {
  libraryFolderRepositoryContract(() => createInMemoryLibraryFolderRepository());
});
