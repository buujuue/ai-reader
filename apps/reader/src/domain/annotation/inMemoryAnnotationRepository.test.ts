import { describe, it } from 'vitest';

import { annotationRepositoryContract } from './annotationRepository.contract';
import { createInMemoryAnnotationRepository } from './inMemoryAnnotationRepository';

describe('AnnotationRepository 契约 · 内存 Adapter', () => {
  annotationRepositoryContract(createInMemoryAnnotationRepository);
});