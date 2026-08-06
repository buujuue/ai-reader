import { describe, expect, it } from 'vitest';

import { importRepositoryContract, type ImportContractHarness } from './importRepository.contract';
import {
  createTauriImportRepository,
  IMPORT_COMMAND_NAMES,
} from './tauriImportRepository';
import type { TauriInvoke } from '../tauriInvoke';
import type { ReadingMaterial, StagedImport } from './material';

interface FakeStaged {
  bytes: Uint8Array;
  originalFileName: string;
  fingerprint: string;
}

/** 模拟 Rust 端 typed import 命令:snake_case 命令名、serde camelCase DTO、按指纹去重。 */
function createFakeTauriBackend(): { invoke: TauriInvoke; registerSource: (name: string, bytes: Uint8Array) => void } {
  const files = new Map<string, Uint8Array>();
  const stashed = new Map<string, FakeStaged>();
  const materials = new Map<string, ReadingMaterial>();
  const byFingerprint = new Map<string, ReadingMaterial>();
  const managedBytes = new Map<string, Uint8Array>();

  const invoke: TauriInvoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    switch (command) {
      case IMPORT_COMMAND_NAMES.stage: {
        const sourcePath = (args as { sourcePath?: unknown }).sourcePath as string;
        const bytes = files.get(sourcePath);
        if (!bytes) {
          throw new Error('unknown source file');
        }
        const id = crypto.randomUUID();
        const originalFileName = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
        const fingerprint = await sha256Hex(bytes);
        stashed.set(id, { bytes, originalFileName, fingerprint });
        return { id, originalFileName, fingerprint } satisfies StagedImport;
      }
      case IMPORT_COMMAND_NAMES.readStaged: {
        const staged = (args as { staged?: unknown }).staged as StagedImport;
        const entry = stashed.get(staged.id);
        if (!entry) {
          throw new Error('staged file missing');
        }
        return btoaBinary(entry.bytes);
      }
      case IMPORT_COMMAND_NAMES.commit: {
        const staged = (args as { staged?: unknown }).staged as StagedImport;
        const metadata = (args as { metadata: { title: string; author: string | null; language: string | null } }).metadata;
        const existing = byFingerprint.get(staged.fingerprint);
        if (existing) {
          stashed.delete(staged.id);
          return existing;
        }
        const material: ReadingMaterial = {
          id: crypto.randomUUID(),
          title: metadata.title,
          author: metadata.author ?? null,
          language: metadata.language ?? null,
          fingerprint: staged.fingerprint,
          sourceFileName: staged.originalFileName,
        };
        materials.set(material.id, material);
        byFingerprint.set(material.fingerprint, material);
        const bytes = stashed.get(staged.id)?.bytes;
        if (bytes) {
          managedBytes.set(material.id, bytes);
        }
        stashed.delete(staged.id);
        return material;
      }
      case IMPORT_COMMAND_NAMES.readManaged: {
        const materialId = (args as { materialId?: unknown }).materialId as string;
        const bytes = managedBytes.get(materialId);
        if (!bytes) {
          throw new Error('managed file missing');
        }
        return btoaBinary(bytes);
      }
      case IMPORT_COMMAND_NAMES.list:
        return [...materials.values()];
      case IMPORT_COMMAND_NAMES.recover:
        stashed.clear();
        return null;
      default:
        throw new Error(`unknown tauri command: ${command}`);
    }
  };

  return {
    invoke,
    registerSource(name, bytes) {
      files.set(name, bytes);
    },
  };
}

function createTauriHarness(): ImportContractHarness {
  let backend = createFakeTauriBackend();
  let repository = createTauriImportRepository(backend.invoke);

  return {
    createRepository() {
      backend = createFakeTauriBackend();
      repository = createTauriImportRepository(backend.invoke);
      return repository;
    },
    async stage(name, bytes) {
      backend.registerSource(name, bytes);
      return repository.stageImport(name);
    },
  };
}

describe('ImportRepository 契约 · Tauri Adapter', () => {
  importRepositoryContract(createTauriHarness());
});

describe('TauriImportRepository 边界映射', () => {
  it('使用稳定的 snake_case Tauri 命令名', async () => {
    expect(IMPORT_COMMAND_NAMES.stage).toBe('stage_import');
    expect(IMPORT_COMMAND_NAMES.readStaged).toBe('read_staged_file');
    expect(IMPORT_COMMAND_NAMES.commit).toBe('commit_import');
    expect(IMPORT_COMMAND_NAMES.list).toBe('list_materials');
    expect(IMPORT_COMMAND_NAMES.readManaged).toBe('read_managed_file');
    expect(IMPORT_COMMAND_NAMES.recover).toBe('recover_imports');
  });

  it('暂存时把源路径放入 sourcePath 参数', async () => {
    let received: Record<string, unknown> | undefined;
    const invoke: TauriInvoke = async (_command, args) => {
      received = args;
      return { id: 'x', originalFileName: 'book.epub', fingerprint: 'f' };
    };

    const repository = createTauriImportRepository(invoke);
    await repository.stageImport('C:/books/book.epub');

    expect(received).toEqual({ sourcePath: 'C:/books/book.epub' });
  });

  it('读取暂存文件把 staged 放入参数并解码 base64', async () => {
    let received: Record<string, unknown> | undefined;
    const invoke: TauriInvoke = async (_command, args) => {
      received = args;
      return btoaBinary(new TextEncoder().encode('hello'));
    };

    const repository = createTauriImportRepository(invoke);
    const bytes = await repository.readStagedFile({
      id: 'x',
      originalFileName: 'book.epub',
      fingerprint: 'f',
    });

    expect(received?.staged).toEqual({ id: 'x', originalFileName: 'book.epub', fingerprint: 'f' });
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('读取托管文件把 materialId 放入参数并解码 base64', async () => {
    let received: Record<string, unknown> | undefined;
    const invoke: TauriInvoke = async (_command, args) => {
      received = args;
      return btoaBinary(new TextEncoder().encode('managed'));
    };

    const repository = createTauriImportRepository(invoke);
    const bytes = await repository.readManagedFile('mat-1');

    expect(received?.materialId).toBe('mat-1');
    expect(new TextDecoder().decode(bytes)).toBe('managed');
  });

  it('后端返回异常结构时拒绝加载', async () => {
    const invoke: TauriInvoke = async () => ({ id: 42 });

    const repository = createTauriImportRepository(invoke);

    await expect(
      repository.commitImport(
        { id: 'x', originalFileName: 'book.epub', fingerprint: 'f' },
        { title: '甲', author: null, language: null },
      ),
    ).rejects.toThrow();
  });
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function btoaBinary(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}