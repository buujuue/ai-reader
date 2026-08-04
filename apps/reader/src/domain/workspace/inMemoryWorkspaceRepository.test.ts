import { describe } from 'vitest';

import { createInMemoryWorkspaceRepository } from './inMemoryWorkspaceRepository';
import { workspaceRepositoryContract } from './workspaceRepository.contract';

describe('WorkspaceRepository 契约 · 内存 Adapter', () => {
  workspaceRepositoryContract(createInMemoryWorkspaceRepository);
});
