import { describe, expect, it, vi } from 'vitest';

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
import { formatFromSourceFileName } from './materialFormat';
import { readMarkdownSourceText } from '../reader/markdown/markdownSource';

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
  const byIdentity = new Map<string, ReadingMaterial>();
  const managedBytes = new Map<string, Uint8Array>();
  const trashedBytes = new Map<string, Uint8Array>();
  const covers = new Map<string, Uint8Array>();
  const sourceCovers = new Map<string, { bytes: Uint8Array; mimeType: string }>();
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
      folderId: null,
      source: { title, author, language },
      override: { title: null, author: null, coverSource: null },
      coverSource: null,
      sourceCoverSource: null,
      documentVersion: 0,
      managedFileAvailable: true,
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
        const sourceCover = (args as {
          sourceCover?: { bytes?: string; mimeType?: string } | null;
        }).sourceCover;
        const existing = byIdentity.get(
          `${formatFromSourceFileName(staged.originalFileName)}:${staged.fingerprint}`,
        );
        if (existing) {
          const stored = materials.get(existing.id) ?? existing;
          const stagedBytes = stashed.get(staged.id)?.bytes;
          if (!managedBytes.has(stored.id) && stagedBytes) {
            managedBytes.set(stored.id, new Uint8Array(stagedBytes));
          }
          if (sourceCover) {
            sourceCovers.set(stored.id, {
              bytes: base64ToBytes(sourceCover.bytes!),
              mimeType: sourceCover.mimeType!,
            });
          }
          trashedBytes.delete(stored.id);
          stashed.delete(staged.id);
          trashed.delete(stored.id);
          const relinked = {
            ...stored,
            sourceCoverSource: sourceCovers.has(stored.id) ? stored.id : null,
            managedFileAvailable: managedBytes.has(stored.id),
          };
          materials.set(stored.id, relinked);
          byIdentity.set(
            `${formatFromSourceFileName(relinked.sourceFileName)}:${relinked.fingerprint}`,
            relinked,
          );
          return relinked;
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
        byIdentity.set(
          `${formatFromSourceFileName(material.sourceFileName)}:${material.fingerprint}`,
          material,
        );
        const bytes = stashed.get(staged.id)?.bytes;
        if (bytes) {
          managedBytes.set(material.id, bytes);
        }
        if (sourceCover) {
          sourceCovers.set(material.id, {
            bytes: base64ToBytes(sourceCover.bytes!),
            mimeType: sourceCover.mimeType!,
          });
          material.sourceCoverSource = material.id;
        }
        stashed.delete(staged.id);
        return material;
      }
      case IMPORT_COMMAND_NAMES.managedInfo: {
        const materialId = (args as { materialId?: unknown }).materialId as string;
        const material = materials.get(materialId);
        const bytes = managedBytes.get(materialId);
        if (!material || !bytes || trashed.has(materialId)) {
          throw new Error('managed file missing');
        }
        return { name: material.sourceFileName, size: bytes.byteLength };
      }
      case IMPORT_COMMAND_NAMES.readManagedRange: {
        const { materialId, offset, length } = args as {
          materialId: string;
          offset: number;
          length: number;
        };
        const bytes = managedBytes.get(materialId);
        if (!bytes || trashed.has(materialId)) {
          throw new Error('managed file missing');
        }
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          length > 8 * 1024 * 1024 ||
          offset > bytes.byteLength ||
          length > bytes.byteLength - offset
        ) {
          throw new Error('managed file range invalid');
        }
        return btoaBinary(bytes.slice(offset, offset + length));
      }
      case IMPORT_COMMAND_NAMES.list:
        return [...materials.values()].filter((material) => !trashed.has(material.id));
      case IMPORT_COMMAND_NAMES.moveToFolder: {
        const { materialId, folderId } = args as { materialId: string; folderId: string | null };
        const current = materials.get(materialId);
        if (!current || trashed.has(materialId)) {
          throw new Error('material missing');
        }
        const updated = { ...current, folderId };
        materials.set(materialId, updated);
        return updated;
      }
      case IMPORT_COMMAND_NAMES.listTrashed:
        return [...materials.values()].filter((material) => trashed.has(material.id));
      case IMPORT_COMMAND_NAMES.trash: {
        const { materialId } = args as { materialId: string };
        const current = materials.get(materialId);
        if (!current || trashed.has(materialId)) {
          throw new Error('material missing');
        }
        trashed.add(materialId);
        const managed = managedBytes.get(materialId);
        if (managed) {
          trashedBytes.set(materialId, managed);
          managedBytes.delete(materialId);
        }
        const updated = { ...current, managedFileAvailable: false };
        materials.set(materialId, updated);
        return updated;
      }
      case IMPORT_COMMAND_NAMES.restoreMaterial: {
        const { materialId } = args as { materialId: string };
        const current = materials.get(materialId);
        if (!current || !trashed.has(materialId)) {
          throw new Error('material missing');
        }
        trashed.delete(materialId);
        const trashedCopy = trashedBytes.get(materialId);
        if (trashedCopy) {
          managedBytes.set(materialId, new Uint8Array(trashedCopy));
          trashedBytes.delete(materialId);
        }
        const updated = { ...current, managedFileAvailable: managedBytes.has(materialId) };
        materials.set(materialId, updated);
        return updated;
      }
      case IMPORT_COMMAND_NAMES.relink: {
        const { materialId, staged } = args as { materialId: string; staged: StagedImport };
        const current = materials.get(materialId);
        const stagedFile = stashed.get(staged.id);
        if (
          !current ||
          !stagedFile ||
          current.fingerprint !== staged.fingerprint ||
          formatFromSourceFileName(current.sourceFileName) !==
            formatFromSourceFileName(staged.originalFileName)
        ) {
          throw new Error('relink failed');
        }
        managedBytes.set(materialId, new Uint8Array(stagedFile.bytes));
        trashedBytes.delete(materialId);
        stashed.delete(staged.id);
        const relinked = { ...current, managedFileAvailable: true };
        materials.set(materialId, relinked);
        return relinked;
      }
      case IMPORT_COMMAND_NAMES.purge: {
        const { materialId } = args as { materialId: string };
        const current = materials.get(materialId);
        if (!current || !trashed.has(materialId)) {
          throw new Error('material missing');
        }
        materials.delete(materialId);
        byIdentity.delete(
          `${formatFromSourceFileName(current.sourceFileName)}:${current.fingerprint}`,
        );
        managedBytes.delete(materialId);
        trashedBytes.delete(materialId);
        covers.delete(materialId);
        sourceCovers.delete(materialId);
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
        const source = sourceCovers.get(materialId);
        if (!bytes) {
          return source
            ? { bytes: btoaBinary(source.bytes), mimeType: source.mimeType }
            : null;
        }
        return { bytes: btoaBinary(bytes), mimeType: 'image/jpeg' };
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
        byIdentity.delete(
          `${formatFromSourceFileName(current.sourceFileName)}:${current.fingerprint}`,
        );
        byIdentity.set(
          `${formatFromSourceFileName(effective.sourceFileName)}:${fingerprint}`,
          effective,
        );
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
    expect(IMPORT_COMMAND_NAMES.moveToFolder).toBe('move_material_to_folder');
    expect(IMPORT_COMMAND_NAMES.listTrashed).toBe('list_trashed');
    expect(IMPORT_COMMAND_NAMES.trash).toBe('trash_material');
    expect(IMPORT_COMMAND_NAMES.restoreMaterial).toBe('restore_material');
    expect(IMPORT_COMMAND_NAMES.relink).toBe('relink_material');
    expect(IMPORT_COMMAND_NAMES.purge).toBe('purge_material');
    expect(IMPORT_COMMAND_NAMES.managedInfo).toBe('get_managed_file_info');
    expect(IMPORT_COMMAND_NAMES.readManagedRange).toBe('read_managed_file_range');
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

  it('打开范围来源只把 materialId 传给元数据命令,范围命令不携带文件路径', async () => {
    const received: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: TauriInvoke = async (command, args) => {
      if (args === undefined) {
        received.push({ command });
      } else {
        received.push({ command, args });
      }
      if (command === IMPORT_COMMAND_NAMES.managedInfo) {
        return { name: 'book.epub', size: 10 };
      }
      return btoaBinary(new TextEncoder().encode('2345678901'));
    };

    const repository = createTauriImportRepository(invoke);
    const source = await repository.openManagedFileSource('mat-1');
    await source.slice(2, 6).arrayBuffer();

    expect(received[0]).toEqual({
      command: IMPORT_COMMAND_NAMES.managedInfo,
      args: { materialId: 'mat-1' },
    });
    expect(received[1]).toEqual({
      command: IMPORT_COMMAND_NAMES.readManagedRange,
      args: { materialId: 'mat-1', offset: 0, length: 10 },
    });
    expect(received[1]?.args).not.toHaveProperty('path');
  });

  it('Windows PDF 使用二进制范围协议，不逐块调用通用读取 Command', async () => {
    const invoke = vi.fn<TauriInvoke>(async (command) => {
      if (command === IMPORT_COMMAND_NAMES.managedInfo) {
        return { name: 'large.pdf', size: 10 };
      }
      throw new Error(`不应调用 Tauri 范围 Command:${command}`);
    });
    const fetchFn = vi.fn(async (input: string) => {
      expect(input).toBe(
        'http://managed-range.localhost/?materialId=mat-pdf&offset=0&length=10',
      );
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('0123456789').buffer,
      } as Response;
    });

    const repository = createTauriImportRepository(invoke, {
      useManagedRangeProtocol: true,
      fetchFn,
    });
    const source = await repository.openManagedFileSource('mat-pdf');

    await expect(source.arrayBuffer()).resolves.toEqual(
      new TextEncoder().encode('0123456789').buffer,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(IMPORT_COMMAND_NAMES.managedInfo, {
      materialId: 'mat-pdf',
    });
    expect(invoke).not.toHaveBeenCalledWith(
      IMPORT_COMMAND_NAMES.readManagedRange,
      expect.anything(),
    );
  });

  it('Tauri Markdown Source 可通过多个受控范围读取超过 8 MiB 的完整文本', async () => {
    const size = 8 * 1024 * 1024 + 37;
    const bytes = new Uint8Array(size);
    bytes.fill('a'.charCodeAt(0));
    const ranges: Array<{ offset: number; length: number }> = [];
    const invoke: TauriInvoke = async (command, args) => {
      if (command === IMPORT_COMMAND_NAMES.managedInfo) {
        return { name: 'large.md', size };
      }
      if (command !== IMPORT_COMMAND_NAMES.readManagedRange) {
        throw new Error(`unexpected command: ${command}`);
      }
      const { offset, length } = args as { offset: number; length: number };
      ranges.push({ offset, length });
      if (length > 8 * 1024 * 1024) {
        throw new Error('range exceeds protocol limit');
      }
      return btoaBinary(bytes.slice(offset, offset + length));
    };

    const repository = createTauriImportRepository(invoke);
    const source = await repository.openManagedFileSource('mat-large');
    const text = await readMarkdownSourceText(source);

    expect(text).toBe('a'.repeat(size));
    expect(ranges).toHaveLength(Math.ceil(size / 128 / 1024));
    expect(Math.max(...ranges.map((range) => range.length))).toBe(128 * 1024);
    expect(ranges.every((range) => range.length <= 8 * 1024 * 1024)).toBe(true);
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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
