/**
 * 批注导出的受控文件写入边界。
 * 内容由 TypeScript 按领域语义生成，目标文件由系统保存位置选择器提供，
 * 实际文件写入由 Tauri/Rust 完成。
 */
export interface AnnotationExportWriter {
  writeMarkdown(destinationPath: string, content: string): Promise<void>;
}
