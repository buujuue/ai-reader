import type { ImportRepository } from './importRepository';
import type { ReadingMaterial, SourceMetadata, StagedImport } from './material';

/**
 * 内存导入 Adapter:不启动 Tauri 时用于浏览器降级开发与领域契约测试。
 * 用一个源文件映射模拟外部文件系统,用 sha256 模拟 Rust 的完整内容指纹。
 */
export function createInMemoryImportRepository(
  sources: Map<string, Uint8Array> = new Map(),
): ImportRepository {
  const materials = new Map<string, ReadingMaterial>();
  const byFingerprint = new Map<string, ReadingMaterial>();
  const stagedBytes = new Map<string, Uint8Array>();

  return {
    async stageImport(sourcePath): Promise<StagedImport> {
      const bytes = findSource(sources, sourcePath);
      if (!bytes) {
        throw new Error(`未知源文件:${sourcePath}`);
      }
      const fingerprint = await sha256Hex(bytes);
      const id = crypto.randomUUID();
      stagedBytes.set(id, bytes);
      return {
        id,
        originalFileName: basename(sourcePath),
        fingerprint,
      };
    },

    async readStagedFile(stagedImport): Promise<Uint8Array> {
      const bytes = stagedBytes.get(stagedImport.id);
      if (!bytes) {
        throw new Error('暂存文件不存在:尚未暂存或已被清理');
      }
      return new Uint8Array(bytes);
    },

    async commitImport(stagedImport, metadata): Promise<ReadingMaterial> {
      const existing = byFingerprint.get(stagedImport.fingerprint);
      if (existing) {
        stagedBytes.delete(stagedImport.id);
        return existing;
      }
      const material: ReadingMaterial = {
        id: crypto.randomUUID(),
        title: metadata.title,
        author: metadata.author,
        language: metadata.language,
        fingerprint: stagedImport.fingerprint,
        sourceFileName: stagedImport.originalFileName,
      };
      materials.set(material.id, material);
      byFingerprint.set(material.fingerprint, material);
      stagedBytes.delete(stagedImport.id);
      return { ...material };
    },

    async listMaterials(): Promise<ReadingMaterial[]> {
      return [...materials.values()].map((material) => ({ ...material }));
    },

    async recoverImports(): Promise<void> {
      stagedBytes.clear();
    },
  };
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