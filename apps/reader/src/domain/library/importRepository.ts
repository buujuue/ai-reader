import type { ReadingMaterial, SourceMetadata, StagedImport } from './material';

/** 导入的 typed Repository 边界。TS 只调用这些命令,不接触 SQL、数据库路径或任意文件系统能力。 */
export interface ImportRepository {
  /** 把外部源文件全部字节流式复制到暂存区并计算完整内容指纹。 */
  stageImport(sourcePath: string): Promise<StagedImport>;
  /** 读取暂存文件字节,交给 BookDocument 检查格式与提取元数据。 */
  readStagedFile(staged: StagedImport): Promise<Uint8Array>;
  /** 提交导入:去重、生成 BookId、写入 ready 记录并原子移动托管文件。 */
  commitImport(staged: StagedImport, metadata: SourceMetadata): Promise<ReadingMaterial>;
  /** 列出活跃书库中的阅读材料。 */
  listMaterials(): Promise<ReadingMaterial[]>;
  /** 恢复中断的导入:清理暂存区与孤儿托管文件。 */
  recoverImports(): Promise<void>;
}