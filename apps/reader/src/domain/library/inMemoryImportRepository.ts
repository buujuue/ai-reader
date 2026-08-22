import type { ImportRepository, MarkdownRecoverySnapshot } from './importRepository';
import type {
  VersionMigrationCommitRequest,
  VersionMigrationCommitResult,
  VersionMigrationRestoreResult,
  VersionMigrationSnapshot,
} from './versionMigrationPersistence';
import type {
  MaterialOverride,
  ReadingMaterial,
  SourceMetadata,
  StagedImport,
} from './material';
import { emptyMaterialOverride } from './material';
import { formatFromSourceFileName } from './materialFormat';

/** 内部存储:材料身份与来源快照(不可编辑)分开保存,覆盖值独立保存。 */
interface InternalMaterial {
  id: string;
  fingerprint: string;
  sourceFileName: string;
  source: SourceMetadata;
  /** 材料文档版本:正式保存 Markdown 时递增(EPUB/PDF 内容不可变,为 0)。 */
  documentVersion: number;
}

/**
 * 内存导入 Adapter:不启动 Tauri 时用于浏览器降级开发与领域契约测试。
 * 用一个源文件映射模拟外部文件系统,用 sha256 模拟 Rust 的完整内容指纹。
 * 覆盖值按材料独立保存,读取端做「覆盖优先、来源兜底」的有效元数据合并。
 */
export function createInMemoryImportRepository(
  sources: Map<string, Uint8Array> = new Map(),
): ImportRepository {
  const materials = new Map<string, InternalMaterial>();
  const byIdentity = new Map<string, InternalMaterial>();
  const managedBytes = new Map<string, Uint8Array>();
  const trashedBytes = new Map<string, Uint8Array>();
  const stagedBytes = new Map<string, Uint8Array>();
  const overrides = new Map<string, MaterialOverride>();
  const covers = new Map<string, Uint8Array>();
  /** 回收站:id 集合。普通删除隐藏入口并移除正文副本;恢复即移除标记。 */
  const trashed = new Set<string>();
  /** pending 记录:id → 暂存句柄。stage 时写入,commit/discard/recover 时移除。 */
  const pending = new Map<string, { originalFileName: string; fingerprint: string }>();
  const markdownRecoveries = new Map<
    string,
    Omit<MarkdownRecoverySnapshot, 'status'>
  >();
  const versionMigrationSnapshots = new Map<
    string,
    {
      snapshot: VersionMigrationSnapshot;
      material: InternalMaterial;
      bytes: Uint8Array;
      annotations: VersionMigrationCommitRequest['previousAnnotations'];
      workspaceState: VersionMigrationCommitRequest['previousWorkspaceState'];
    }
  >();

  function toMaterial(internal: InternalMaterial): ReadingMaterial {
    const override = overrides.get(internal.id) ?? emptyMaterialOverride();
    return {
      id: internal.id,
      fingerprint: internal.fingerprint,
      sourceFileName: internal.sourceFileName,
      source: { ...internal.source },
      override: { ...override },
      title: override.title ?? internal.source.title,
      author: override.author ?? internal.source.author,
      language: internal.source.language,
      coverSource: override.coverSource ?? null,
      documentVersion: internal.documentVersion,
      managedFileAvailable: managedBytes.has(internal.id),
    };
  }

  return {
    async stageImport(sourcePath): Promise<StagedImport> {
      const bytes = findSource(sources, sourcePath);
      if (!bytes) {
        throw new Error(`未知源文件:${sourcePath}`);
      }
      const fingerprint = await sha256Hex(bytes);
      const id = crypto.randomUUID();
      const originalFileName = basename(sourcePath);
      stagedBytes.set(id, new Uint8Array(bytes));
      pending.set(id, { originalFileName, fingerprint });
      return { id, originalFileName, fingerprint };
    },

    async readStagedFile(stagedImport): Promise<Uint8Array> {
      const bytes = stagedBytes.get(stagedImport.id);
      if (!bytes) {
        throw new Error('暂存文件不存在:尚未暂存或已被清理');
      }
      return new Uint8Array(bytes);
    },

    async discardImport(stagedImport): Promise<void> {
      stagedBytes.delete(stagedImport.id);
      pending.delete(stagedImport.id);
    },

    async commitImport(stagedImport, metadata): Promise<ReadingMaterial> {
      const existing = byIdentity.get(
        materialIdentityKey(stagedImport.fingerprint, stagedImport.originalFileName),
      );
      if (existing) {
        const stagedBytesForExisting = stagedBytes.get(stagedImport.id);
        if (!managedBytes.has(existing.id) && stagedBytesForExisting) {
          managedBytes.set(existing.id, new Uint8Array(stagedBytesForExisting));
        }
        trashedBytes.delete(existing.id);
        stagedBytes.delete(stagedImport.id);
        pending.delete(stagedImport.id);
        // 回收站中相同内容指纹时恢复原 BookId,不新建。
        if (trashed.has(existing.id)) {
          trashed.delete(existing.id);
        }
        return toMaterial(existing);
      }
      // 材料身份内容寻址:由内容指纹派生,跨会话稳定。这是浏览器降级模式
      // localStorage 批注能跨 reload 关联到同一材料的前提(演示书字节确定性)。
      const id = materialIdFromFingerprint(stagedImport.fingerprint, stagedImport.originalFileName);
      const internal: InternalMaterial = {
        id,
        fingerprint: stagedImport.fingerprint,
        sourceFileName: stagedImport.originalFileName,
        source: { ...metadata },
        documentVersion: 0,
      };
      materials.set(internal.id, internal);
      byIdentity.set(
        materialIdentityKey(internal.fingerprint, internal.sourceFileName),
        internal,
      );
      const bytes = stagedBytes.get(stagedImport.id);
      if (bytes) {
        managedBytes.set(internal.id, new Uint8Array(bytes));
      }
      stagedBytes.delete(stagedImport.id);
      pending.delete(stagedImport.id);
      return toMaterial(internal);
    },

    async listMaterials(): Promise<ReadingMaterial[]> {
      return [...materials.values()]
        .filter((internal) => !trashed.has(internal.id))
        .map(toMaterial);
    },

    async listTrashed(): Promise<ReadingMaterial[]> {
      return [...materials.values()]
        .filter((internal) => trashed.has(internal.id))
        .map(toMaterial);
    },

    async trashMaterial(materialId): Promise<ReadingMaterial> {
      const internal = requireInternal(materials, materialId);
      if (trashed.has(materialId)) {
        throw new Error(`托管书库中不存在该阅读材料:${materialId}`);
      }
      trashed.add(materialId);
      const managed = managedBytes.get(materialId);
      if (managed) {
        trashedBytes.set(materialId, managed);
        managedBytes.delete(materialId);
      }
      return toMaterial(internal);
    },

    async restoreMaterial(materialId): Promise<ReadingMaterial> {
      const internal = requireInternal(materials, materialId);
      if (!trashed.has(materialId)) {
        throw new Error(`托管书库中不存在该阅读材料:${materialId}`);
      }
      trashed.delete(materialId);
      const trashedCopy = trashedBytes.get(materialId);
      if (trashedCopy) {
        managedBytes.set(materialId, new Uint8Array(trashedCopy));
        trashedBytes.delete(materialId);
      }
      return toMaterial(internal);
    },

    async relinkMaterial(materialId, stagedImport): Promise<ReadingMaterial> {
      const internal = requireInternal(materials, materialId);
      if (
        internal.fingerprint !== stagedImport.fingerprint ||
        formatFromSourceFileName(internal.sourceFileName) !==
          formatFromSourceFileName(stagedImport.originalFileName)
      ) {
        throw new Error('重新关联文件的完整内容指纹不匹配');
      }
      const bytes = stagedBytes.get(stagedImport.id);
      if (!bytes) {
        throw new Error('重新关联暂存文件不存在');
      }
      managedBytes.set(materialId, new Uint8Array(bytes));
      trashedBytes.delete(materialId);
      stagedBytes.delete(stagedImport.id);
      pending.delete(stagedImport.id);
      return toMaterial(internal);
    },

    async purgeMaterial(materialId): Promise<void> {
      const internal = requireInternal(materials, materialId);
      if (!trashed.has(materialId)) {
        throw new Error(`托管书库中不存在该阅读材料:${materialId}`);
      }
      materials.delete(materialId);
      byIdentity.delete(materialIdentityKey(internal.fingerprint, internal.sourceFileName));
      managedBytes.delete(materialId);
      trashedBytes.delete(materialId);
      covers.delete(materialId);
      overrides.delete(materialId);
      markdownRecoveries.delete(materialId);
      for (const [snapshotId, stored] of versionMigrationSnapshots) {
        if (stored.snapshot.materialId === materialId) {
          versionMigrationSnapshots.delete(snapshotId);
        }
      }
      trashed.delete(materialId);
    },

    async readManagedFile(materialId): Promise<Uint8Array> {
      const bytes = managedBytes.get(materialId);
      if (!bytes) {
        throw new Error(`托管书库中不存在该阅读材料:${materialId}`);
      }
      return new Uint8Array(bytes);
    },

    async recoverImports(): Promise<void> {
      // 回滚所有未提交的 pending 导入:清理暂存字节与 pending 记录。
      pending.clear();
      stagedBytes.clear();
    },

    async applyMaterialMetadata(materialId, title, author): Promise<ReadingMaterial> {
      const internal = requireInternal(materials, materialId);
      const current = overrides.get(materialId) ?? emptyMaterialOverride();
      overrides.set(materialId, { ...current, title, author });
      return toMaterial(internal);
    },

    async setMaterialCover(materialId, sourcePath): Promise<ReadingMaterial> {
      const internal = requireInternal(materials, materialId);
      const bytes = findSource(sources, sourcePath);
      if (!bytes) {
        throw new Error(`未知封面源文件:${sourcePath}`);
      }
      const managedName = materialId;
      covers.set(materialId, bytes);
      const current = overrides.get(materialId) ?? emptyMaterialOverride();
      overrides.set(materialId, { ...current, coverSource: managedName });
      return toMaterial(internal);
    },

    async removeMaterialCover(materialId): Promise<ReadingMaterial> {
      const internal = requireInternal(materials, materialId);
      covers.delete(materialId);
      const current = overrides.get(materialId) ?? emptyMaterialOverride();
      overrides.set(materialId, { ...current, coverSource: null });
      return toMaterial(internal);
    },

    async restoreSourceMetadata(materialId): Promise<ReadingMaterial> {
      const internal = requireInternal(materials, materialId);
      covers.delete(materialId);
      overrides.delete(materialId);
      return toMaterial(internal);
    },

    async readCover(materialId): Promise<Uint8Array | null> {
      const bytes = covers.get(materialId);
      if (!bytes) {
        return null;
      }
      return new Uint8Array(bytes);
    },

    async commitVersionMigration(
      request: VersionMigrationCommitRequest,
    ): Promise<VersionMigrationCommitResult> {
      const internal = requireInternal(materials, request.materialId);
      if (internal.fingerprint !== request.expectedSourceFingerprint) {
        throw new Error('版本迁移源材料已变化,请重新预览');
      }
      if (request.staged.fingerprint !== request.expectedTargetFingerprint) {
        throw new Error('版本迁移暂存文件指纹不匹配');
      }
      const bytes = stagedBytes.get(request.staged.id);
      if (!bytes) {
        throw new Error('版本迁移暂存文件不存在');
      }
      const targetKey = materialIdentityKey(
        request.expectedTargetFingerprint,
        request.staged.originalFileName,
      );
      const collision = byIdentity.get(targetKey);
      if (collision && collision.id !== internal.id) {
        throw new Error('新版本已作为另一份阅读材料存在,未执行迁移');
      }

      const snapshotId = crypto.randomUUID();
      versionMigrationSnapshots.set(snapshotId, {
        snapshot: {
          id: snapshotId,
          materialId: internal.id,
          sourceFingerprint: internal.fingerprint,
          targetFingerprint: request.expectedTargetFingerprint,
          createdAt: Date.now(),
          status: 'available',
        },
        material: { ...internal, source: { ...internal.source } },
        bytes: new Uint8Array(managedBytes.get(internal.id) ?? []),
        annotations: structuredClone(request.previousAnnotations),
        workspaceState: structuredClone(request.previousWorkspaceState),
      });

      byIdentity.delete(materialIdentityKey(internal.fingerprint, internal.sourceFileName));
      internal.fingerprint = request.expectedTargetFingerprint;
      internal.sourceFileName = request.staged.originalFileName;
      internal.source = { ...request.metadata };
      managedBytes.set(internal.id, new Uint8Array(bytes));
      byIdentity.set(targetKey, internal);
      stagedBytes.delete(request.staged.id);
      pending.delete(request.staged.id);
      return { material: toMaterial(internal), snapshotId };
    },

    async listVersionMigrationSnapshots(): Promise<VersionMigrationSnapshot[]> {
      return [...versionMigrationSnapshots.values()]
        .map(({ snapshot }) => ({ ...snapshot }))
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async restoreVersionMigrationSnapshot(
      snapshotId: string,
    ): Promise<VersionMigrationRestoreResult> {
      const stored = versionMigrationSnapshots.get(snapshotId);
      if (!stored) throw new Error(`迁移恢复快照不存在:${snapshotId}`);
      const current = requireInternal(materials, stored.material.id);
      byIdentity.delete(materialIdentityKey(current.fingerprint, current.sourceFileName));
      materials.set(stored.material.id, { ...stored.material, source: { ...stored.material.source } });
      managedBytes.set(stored.material.id, new Uint8Array(stored.bytes));
      byIdentity.set(
        materialIdentityKey(stored.material.fingerprint, stored.material.sourceFileName),
        materials.get(stored.material.id)!,
      );
      return {
        material: toMaterial(materials.get(stored.material.id)!),
        annotations: [...structuredClone(stored.annotations)],
        workspaceState: structuredClone(stored.workspaceState),
      };
    },

    async clearVersionMigrationSnapshot(snapshotId: string): Promise<void> {
      versionMigrationSnapshots.delete(snapshotId);
    },

    async saveMarkdown(materialId, content): Promise<ReadingMaterial> {
      const internal = requireInternal(materials, materialId);
      const bytes = new TextEncoder().encode(content);
      const fingerprint = await sha256Hex(bytes);
      managedBytes.set(materialId, bytes);
      byIdentity.delete(materialIdentityKey(internal.fingerprint, internal.sourceFileName));
      internal.fingerprint = fingerprint;
      internal.documentVersion += 1;
      byIdentity.set(materialIdentityKey(internal.fingerprint, internal.sourceFileName), internal);
      return toMaterial(internal);
    },

    async writeMarkdownRecovery(materialId, content, baseDocumentVersion): Promise<void> {
      if (!materials.has(materialId)) {
        throw new Error(`阅读材料不存在:${materialId}`);
      }
      markdownRecoveries.set(materialId, {
        materialId,
        content,
        baseDocumentVersion,
        updatedAt: Date.now(),
      });
    },

    async listMarkdownRecoveries(): Promise<MarkdownRecoverySnapshot[]> {
      return [...markdownRecoveries.values()].map((snapshot) => ({
        ...snapshot,
        status:
          materials.get(snapshot.materialId)?.documentVersion === snapshot.baseDocumentVersion
            ? 'available'
            : 'conflict',
      }));
    },

    async discardMarkdownRecovery(materialId): Promise<void> {
      markdownRecoveries.delete(materialId);
    },
  };
}

function requireInternal(
  materials: Map<string, InternalMaterial>,
  materialId: string,
): InternalMaterial {
  const internal = materials.get(materialId);
  if (!internal) {
    throw new Error(`托管书库中不存在该阅读材料:${materialId}`);
  }
  return internal;
}

/** 由内容指纹派生稳定的材料身份(内容寻址)。 */
function materialIdFromFingerprint(fingerprint: string, sourceFileName: string): string {
  return `mat-${formatFromSourceFileName(sourceFileName)}-${fingerprint}`;
}

function materialIdentityKey(fingerprint: string, sourceFileName: string): string {
  return `${formatFromSourceFileName(sourceFileName)}:${fingerprint}`;
}

function findSource(
  sources: Map<string, Uint8Array>,
  sourcePath: string,
): Uint8Array | undefined {
  const direct = sources.get(sourcePath);
  if (direct) {
    return direct;
  }
  const target = basename(sourcePath);
  for (const [key, bytes] of sources) {
    if (basename(key) === target) {
      return bytes;
    }
  }
  return undefined;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** 在内存 Adapter 中登记一个源文件。 */
export function addInMemorySource(
  sources: Map<string, Uint8Array>,
  name: string,
  bytes: Uint8Array,
): void {
  sources.set(name, bytes);
}
