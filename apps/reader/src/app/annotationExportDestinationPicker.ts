import { save } from '@tauri-apps/plugin-dialog';

/** 单本批注 Markdown 的系统保存位置选择器。取消选择返回 null。 */
export interface AnnotationExportDestinationPicker {
  pickAnnotationExportDestination(defaultFileName: string): Promise<string | null>;
}

export function createTauriAnnotationExportDestinationPicker(): AnnotationExportDestinationPicker {
  return {
    async pickAnnotationExportDestination(defaultFileName: string): Promise<string | null> {
      return await save({
        defaultPath: defaultFileName,
        filters: [{ name: 'Markdown 批注', extensions: ['md'] }],
      });
    },
  };
}

/** 浏览器降级不直接写任意本地文件，明确返回取消。 */
export function createInMemoryAnnotationExportDestinationPicker(): AnnotationExportDestinationPicker {
  return {
    async pickAnnotationExportDestination(): Promise<string | null> {
      return null;
    },
  };
}
