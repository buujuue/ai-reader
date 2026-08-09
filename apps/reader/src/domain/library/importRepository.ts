import type { ReadingMaterial, SourceMetadata, StagedImport } from './material';

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
  /** 列出回收站中的阅读材料(普通删除保留全部数据,仅从活跃书库隐藏)。 */
  listTrashed(): Promise<ReadingMaterial[]>;
  /** 普通删除:把阅读材料移入回收站并从活跃书库隐藏,保留 BookId、托管文件、封面与全部数据。 */
  trashMaterial(materialId: string): Promise<ReadingMaterial>;
  /** 从回收站恢复阅读材料,继续使用原 BookId 与全部阅读数据。 */
  restoreMaterial(materialId: string): Promise<ReadingMaterial>;
  /** 永久删除回收站中的材料:级联清理托管文件、封面与记录。不可恢复。 */
  purgeMaterial(materialId: string): Promise<void>;
  /** 读取已提交托管文件的原始字节,交给前端 BookDocument 打开阅读。 */
  readManagedFile(materialId: string): Promise<Uint8Array>;
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
  /** 正式保存 Markdown 内容:由 Rust 原子替换托管文件、递增文档版本并更新完整内容指纹,BookId 保持不变。 */
  saveMarkdown(materialId: string, content: string): Promise<ReadingMaterial>;
}