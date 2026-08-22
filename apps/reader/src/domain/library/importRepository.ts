import type { ReadingMaterial, SourceMetadata, StagedImport } from './material';
import type {
  VersionMigrationCommitRequest,
  VersionMigrationCommitResult,
  VersionMigrationRestoreResult,
  VersionMigrationSnapshot,
} from './versionMigrationPersistence';
import type { ManagedFileSource } from './managedFileSource';

export type MarkdownRecoveryStatus = 'available' | 'conflict' | 'corrupt';

/** Markdown 未保存缓冲区的恢复快照。正式材料版本变化时只标记冲突，不自动覆盖。 */
export interface MarkdownRecoverySnapshot {
  materialId: string;
  content: string | null;
  baseDocumentVersion: number | null;
  updatedAt: number | null;
  status: MarkdownRecoveryStatus;
}

/** 导入的 typed Repository 边界。TS 只调用这些命令,不接触 SQL、数据库路径或任意文件系统能力。 */
export interface ImportRepository {
  /** 把外部源文件全部字节流式复制到暂存区并计算完整内容指纹。 */
  stageImport(sourcePath: string): Promise<StagedImport>;
  /** 读取暂存文件字节,交给 BookDocument 检查格式与提取元数据。 */
  readStagedFile(staged: StagedImport): Promise<Uint8Array>;
  /** 丢弃一份不再需要的暂存文件(检查失败或用户中止时调用);暂存文件不存在时幂等。 */
  discardImport(staged: StagedImport): Promise<void>;
  /** 提交导入:去重、生成 BookId、写入 ready 记录并原子移动托管文件。 */
  commitImport(staged: StagedImport, metadata: SourceMetadata): Promise<ReadingMaterial>;
  /** 列出活跃书库中的阅读材料(带覆盖优先、来源兜底的有效元数据)。 */
  listMaterials(): Promise<ReadingMaterial[]>;
  /** 列出回收站中的阅读材料(普通删除仅隐藏入口并移除正文副本,保留用户数据)。 */
  listTrashed(): Promise<ReadingMaterial[]>;
  /** 普通删除:隐藏书库入口并移除正文副本,保留 BookId、封面与全部用户数据。 */
  trashMaterial(materialId: string): Promise<ReadingMaterial>;
  /** 从回收站恢复阅读材料,继续使用原 BookId 与全部阅读数据。 */
  restoreMaterial(materialId: string): Promise<ReadingMaterial>;
  /**
   * 用一份完整内容指纹相同的暂存文件重新关联既有材料。
   * 只替换托管副本,不改变 BookId、元数据、阅读位置或批注。
   */
  relinkMaterial(materialId: string, staged: StagedImport): Promise<ReadingMaterial>;
  /** 永久删除回收站中的材料:级联清理托管文件、封面与记录。不可恢复。 */
  purgeMaterial(materialId: string): Promise<void>;
  /**
   * 打开只读的惰性托管材料来源。来源只暴露 File/Blob 兼容能力，格式层不接触
   * Tauri 命令、数据库或托管文件路径；Markdown 打开/编辑路径必须使用该来源。
   * 所有阅读格式路径必须使用该 Source；范围读取失败时不得回退为全量字节缓冲。
   */
  openManagedFileSource(materialId: string): Promise<ManagedFileSource>;
  /** 恢复中断的导入:清理暂存区与孤儿托管文件。 */
  recoverImports(): Promise<void>;
  /** 覆盖/清除标题与作者。title/author 为 null 表示清除对应覆盖并回落到来源。返回更新后的有效材料。 */
  applyMaterialMetadata(
    materialId: string,
    title: string | null,
    author: string | null,
  ): Promise<ReadingMaterial>;
  /** 把外部图片复制进托管封面空间并设为自定义封面。外部原文件不被修改或删除。返回更新后的有效材料。 */
  setMaterialCover(materialId: string, sourcePath: string): Promise<ReadingMaterial>;
  /** 移除自定义封面:删除托管封面文件并清除覆盖,回落到来源封面。返回更新后的有效材料。 */
  removeMaterialCover(materialId: string): Promise<ReadingMaterial>;
  /** 一键清除全部覆盖并恢复来源标题、作者与封面。返回更新后的有效材料。 */
  restoreSourceMetadata(materialId: string): Promise<ReadingMaterial>;
  /** 读取托管封面文件的原始字节供界面渲染;无自定义封面时返回 null。 */
  readCover(materialId: string): Promise<Uint8Array | null>;
  /**
   * 显式提交一份 EPUB 版本迁移。Rust 在同一可恢复操作中校验旧/新指纹,
   * 创建本地快照,替换托管文件并提交材料、批注和工作区状态。
   */
  commitVersionMigration(
    request: VersionMigrationCommitRequest,
  ): Promise<VersionMigrationCommitResult>;
  /** 列出持续保留的本地迁移恢复快照。 */
  listVersionMigrationSnapshots(): Promise<VersionMigrationSnapshot[]>;
  /** 完整恢复一份迁移前快照,返回恢复后的材料、批注和工作区状态。 */
  restoreVersionMigrationSnapshot(snapshotId: string): Promise<VersionMigrationRestoreResult>;
  /** 用户明确清除一份恢复快照;不存在时幂等。 */
  clearVersionMigrationSnapshot(snapshotId: string): Promise<void>;
  /** 正式保存 Markdown 内容:由 Rust 原子替换托管文件、递增文档版本并更新完整内容指纹,BookId 保持不变。 */
  saveMarkdown(materialId: string, content: string): Promise<ReadingMaterial>;
  /** 原子写入 Markdown 恢复快照;不修改正式文件、指纹或文档版本。 */
  writeMarkdownRecovery(
    materialId: string,
    content: string,
    baseDocumentVersion: number,
  ): Promise<void>;
  /** 列出恢复快照,并相对当前正式文档版本标记 available/conflict/corrupt。 */
  listMarkdownRecoveries(): Promise<MarkdownRecoverySnapshot[]>;
  /** 显式丢弃恢复快照;不存在时幂等。 */
  discardMarkdownRecovery(materialId: string): Promise<void>;
}
