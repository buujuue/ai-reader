import { describe, expect, it } from 'vitest';

import { importRepositoryContract, type ImportContractHarness } from './importRepository.contract';
import { importBatchContract, type ImportBatchContractHarness } from './importBatch.contract';
import { metadataRepositoryContract } from './metadataRepository.contract';
import { recycleBinRepositoryContract } from './recycleBinRepository.contract';
import {
  createTauriImportRepository,
  IMPORT_COMMAND_NAMES,
} from './tauriImportRepository';
import type { TauriInvoke } from '../tauriInvoke';
import type { ReadingMaterial, StagedImport } from './material';
import type { MarkdownRecoverySnapshot } from './importRepository';
import type { FilePicker } from '../../app/filePicker';

interface FakeStaged {
  bytes: Uint8Array;
  originalFileName: string;
  fingerprint: string;
}

/** 模拟 Rust 端 typed import 命令:snake_case 命令名、serde camelCase DTO、按指纹去重。 */
function createFakeTauriBackend(): {
  invoke: TauriInvoke;
  registerSource: (name: string, bytes: Uint8Array) => void;
} {
  const files = new Map<string, Uint8Array>();
  const stashed = new Map<string, FakeStaged>();
  const materials = new Map<string, ReadingMaterial>();
  const byFingerprint = new Map<string, ReadingMaterial>();
  const managedBytes = new Map<string, Uint8Array>();
  const covers = new Map<string, Uint8Array>();
  const trashed = new Set<string>();
  const markdownRecoveries = new Map<
    string,
    Omit<MarkdownRecoverySnapshot, 'status'>
  >();

  function base(id: string, title: string, author: string | null, language: string | null, fingerprint: string, sourceFileName: string): ReadingMaterial {
    return {
      id,
      title,
      author,
      language,
      fingerprint,
      sourceFileName,
      source: { title, author, language },
      override: { title: null, author: null, coverSource: null },
      coverSource: null,
      documentVersion: 0,
    };
  }

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
      case IMPORT_COMMAND_NAMES.discard: {
        const staged = (args as { staged?: unknown }).staged as StagedImport;
        stashed.delete(staged.id);
        return null;
      }
      case IMPORT_COMMAND_NAMES.commit: {
        const staged = (args as { staged?: unknown }).staged as StagedImport;
        const metadata = (args as { metadata: { title: string; author: string | null; language: string | null } }).metadata;
        const existing = byFingerprint.get(staged.fingerprint);
        if (existing) {
          stashed.delete(staged.id);
          trashed.delete(existing.id);
          return existing;
        }
        const material = base(
          crypto.randomUUID(),
          metadata.title,
          metadata.author ?? null,
          metadata.language ?? null,
          staged.fingerprint,
          staged.originalFileName,
        );
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
        return [...materials.values()].filter((material) => !trashed.has(material.id));
      case IMPORT_COMMAND_NAMES.listTrashed:
        return [...materials.values()].filter((material) => trashed.has(material.id));
      case IMPORT_COMMAND_NAMES.trash: {
        const { materialId } = args as { materialId: string };
        const current = materials.get(materialId);
        if (!current || trashed.has(materialId)) {
          throw new Error('material missing');
        }
        trashed.add(materialId);
        return current;
      }
      case IMPORT_COMMAND_NAMES.restoreMaterial: {
        const { materialId } = args as { materialId: string };
        const current = materials.get(materialId);
        if (!current || !trashed.has(materialId)) {
          throw new Error('material missing');
        }
        trashed.delete(materialId);
        return current;
      }
      case IMPORT_COMMAND_NAMES.purge: {
        const { materialId } = args as { materialId: string };
        const current = materials.get(materialId);
        if (!current || !trashed.has(materialId)) {
          throw new Error('material missing');
        }
        materials.delete(materialId);
        byFingerprint.delete(current.fingerprint);
        managedBytes.delete(materialId);
        covers.delete(materialId);
        markdownRecoveries.delete(materialId);
        trashed.delete(materialId);
        return null;
      }
      case IMPORT_COMMAND_NAMES.recover:
        stashed.clear();
        return null;
      case IMPORT_COMMAND_NAMES.applyMetadata: {
        const { materialId, title, author } = args as {
          materialId: string;
          title: string | null;
          author: string | null;
        };
        const current = materials.get(materialId);
        if (!current) {
          throw new Error('material missing');
        }
        const override = { ...current.override, title, author };
        const effective = {
          ...current,
          override,
          title: override.title ?? current.source.title,
          author: override.author ?? current.source.author,
        };
        materials.set(materialId, effective);
        return effective;
      }
      case IMPORT_COMMAND_NAMES.setCover: {
        const { materialId, sourcePath } = args as {
          materialId: string;
          sourcePath: string;
        };
        const current = materials.get(materialId);
        if (!current) {
          throw new Error('material missing');
        }
        const bytes = files.get(sourcePath);
        if (!bytes) {
          throw new Error('unknown cover source file');
        }
        const coverSource = materialId;
        covers.set(materialId, bytes);
        const override = { ...current.override, coverSource };
        const effective = { ...current, override, coverSource };
        materials.set(materialId, effective);
        return effective;
      }
      case IMPORT_COMMAND_NAMES.removeCover: {
        const { materialId } = args as { materialId: string };
        const current = materials.get(materialId);
        if (!current) {
          throw new Error('material missing');
        }
        covers.delete(materialId);
        const override = { ...current.override, coverSource: null };
        const effective = { ...current, override, coverSource: null };
        materials.set(materialId, effective);
        return effective;
      }
      case IMPORT_COMMAND_NAMES.restore: {
        const { materialId } = args as { materialId: string };
        const current = materials.get(materialId);
        if (!current) {
          throw new Error('material missing');
        }
        covers.delete(materialId);
        const effective = {
          ...current,
          override: { title: null, author: null, coverSource: null },
          title: current.source.title,
          author: current.source.author,
          coverSource: null,
        };
        materials.set(materialId, effective);
        return effective;
      }
      case IMPORT_COMMAND_NAMES.readCover: {
        const { materialId } = args as { materialId: string };
        const bytes = covers.get(materialId);
        if (!bytes) {
          return null;
        }
        return btoaBinary(bytes);
      }
      case IMPORT_COMMAND_NAMES.saveMarkdown: {
        const { materialId, content } = args as { materialId: string; content: string };
        const current = materials.get(materialId);
        if (!current) {
          throw new Error('material missing');
        }
        const bytes = new TextEncoder().encode(content);
        const fingerprint = await sha256Hex(bytes);
        managedBytes.set(materialId, bytes);
        const effective = {
          ...current,
          fingerprint,
          documentVersion: (current.documentVersion ?? 0) + 1,
        };
        materials.set(materialId, effective);
        byFingerprint.delete(current.fingerprint);
        byFingerprint.set(fingerprint, effective);
        return effective;
      }
      case IMPORT_COMMAND_NAMES.writeMarkdownRecovery: {
        const { materialId, content, baseDocumentVersion } = args as {
          materialId: string;
          content: string;
          baseDocumentVersion: number;
        };
        if (!materials.has(materialId)) {
          throw new Error('material missing');
        }
        markdownRecoveries.set(materialId, {
          materialId,
          content,
          baseDocumentVersion,
          updatedAt: Date.now(),
        });
        return null;
      }
      case IMPORT_COMMAND_NAMES.listMarkdownRecoveries:
        return [...markdownRecoveries.values()].map((snapshot) => ({
          ...snapshot,
          status:
            materials.get(snapshot.materialId)?.documentVersion === snapshot.baseDocumentVersion
              ? 'available'
              : 'conflict',
        }));
      case IMPORT_COMMAND_NAMES.discardMarkdownRecovery: {
        const { materialId } = args as { materialId: string };
        markdownRecoveries.delete(materialId);
        return null;
      }
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
    registerCoverSource(name, bytes) {
      backend.registerSource(name, bytes);
    },
  };
}

function createTauriBatchHarness(): ImportBatchContractHarness {
  let backend = createFakeTauriBackend();
  let repository = createTauriImportRepository(backend.invoke);

  return {
    createRepository() {
      backend = createFakeTauriBackend();
      repository = createTauriImportRepository(backend.invoke);
      return repository;
    },
    registerSource(path, bytes) {
      backend.registerSource(path, bytes);
    },
    createPicker(paths) {
      return {
        async pickBooks() {
          return paths ? [...paths] : null;
        },
        async pickImage() {
          return null;
        },
      } satisfies FilePicker;
    },
  };
}

describe('ImportRepository 契约 · Tauri Adapter', () => {
  importRepositoryContract(createTauriHarness());
});

describe('元数据覆盖契约 · Tauri Adapter', () => {
  metadataRepositoryContract(createTauriHarness());
});

describe('回收站契约 · Tauri Adapter', () => {
  recycleBinRepositoryContract(createTauriHarness());
});

describe('批量导入契约 · Tauri Adapter', () => {
  importBatchContract(createTauriBatchHarness());
});

describe('TauriImportRepository 边界映射', () => {
  it('使用稳定的 snake_case Tauri 命令名', async () => {
    expect(IMPORT_COMMAND_NAMES.stage).toBe('stage_import');
    expect(IMPORT_COMMAND_NAMES.readStaged).toBe('read_staged_file');
    expect(IMPORT_COMMAND_NAMES.discard).toBe('discard_import');
    expect(IMPORT_COMMAND_NAMES.commit).toBe('commit_import');
    expect(IMPORT_COMMAND_NAMES.list).toBe('list_materials');
    expect(IMPORT_COMMAND_NAMES.listTrashed).toBe('list_trashed');
    expect(IMPORT_COMMAND_NAMES.trash).toBe('trash_material');
    expect(IMPORT_COMMAND_NAMES.restoreMaterial).toBe('restore_material');
    expect(IMPORT_COMMAND_NAMES.purge).toBe('purge_material');
    expect(IMPORT_COMMAND_NAMES.readManaged).toBe('read_managed_file');
    expect(IMPORT_COMMAND_NAMES.recover).toBe('recover_imports');
    expect(IMPORT_COMMAND_NAMES.applyMetadata).toBe('apply_material_metadata');
    expect(IMPORT_COMMAND_NAMES.setCover).toBe('set_material_cover');
    expect(IMPORT_COMMAND_NAMES.removeCover).toBe('remove_material_cover');
    expect(IMPORT_COMMAND_NAMES.restore).toBe('restore_source_metadata');
    expect(IMPORT_COMMAND_NAMES.readCover).toBe('read_material_cover');
    expect(IMPORT_COMMAND_NAMES.saveMarkdown).toBe('save_markdown');
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
