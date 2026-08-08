import type { ImportRepository } from './importRepository';
import type {
  MaterialOverride,
  ReadingMaterial,
  SourceMetadata,
  StagedImport,
} from './material';
import { emptyMaterialOverride } from './material';

/** 内部存储:材料身份与来源快照(不可编辑)分开保存,覆盖值独立保存。 */
interface InternalMaterial {
  id: string;
  fingerprint: string;
  sourceFileName: string;
  source: SourceMetadata;
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
  const byFingerprint = new Map<string, InternalMaterial>();
  const managedBytes = new Map<string, Uint8Array>();
  const stagedBytes = new Map<string, Uint8Array>();
  const overrides = new Map<string, MaterialOverride>();
  const covers = new Map<string, Uint8Array>();
  /** 回收站:id 集合。普通删除只隐藏,保留全部数据;恢复即移除。 */
  const trashed = new Set<string>();
  /** pending 记录:id → 暂存句柄。stage 时写入,commit/discard/recover 时移除。 */
  const pending = new Map<string, { originalFileName: string; fingerprint: string }>();

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
      stagedBytes.set(id, bytes);
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
      const existing = byFingerprint.get(stagedImport.fingerprint);
      if (existing) {
        stagedBytes.delete(stagedImport.id);
        pending.delete(stagedImport.id);
        // 回收站中相同内容指纹时恢复原 BookId,不新建。
        if (trashed.has(existing.id)) {
          trashed.delete(existing.id);
        }
        return toMaterial(existing);
      }
      const internal: InternalMaterial = {
        id: stagedImport.id,
        fingerprint: stagedImport.fingerprint,
        sourceFileName: stagedImport.originalFileName,
        source: { ...metadata },
      };
      materials.set(internal.id, internal);
      byFingerprint.set(internal.fingerprint, internal);
      const bytes = stagedBytes.get(stagedImport.id);
      if (bytes) {
        managedBytes.set(internal.id, bytes);
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
      return toMaterial(internal);
    },

    async restoreMaterial(materialId): Promise<ReadingMaterial> {
      const internal = requireInternal(materials, materialId);
      if (!trashed.has(materialId)) {
        throw new Error(`托管书库中不存在该阅读材料:${materialId}`);
      }
      trashed.delete(materialId);
      return toMaterial(internal);
    },

    async purgeMaterial(materialId): Promise<void> {
      const internal = requireInternal(materials, materialId);
      if (!trashed.has(materialId)) {
        throw new Error(`托管书库中不存在该阅读材料:${materialId}`);
      }
      materials.delete(materialId);
      byFingerprint.delete(internal.fingerprint);
      managedBytes.delete(materialId);
      covers.delete(materialId);
      overrides.delete(materialId);
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