import { backupRepositoryContract } from './backupRepository.contract';
import { createInMemoryBackupRepository } from './inMemoryBackupRepository';

backupRepositoryContract(() => createInMemoryBackupRepository());
