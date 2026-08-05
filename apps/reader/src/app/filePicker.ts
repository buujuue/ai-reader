import { open } from '@tauri-apps/plugin-dialog';

/** 系统文件选择器窄接口。取消选择返回 null,不产生任何记录或暂存文件。 */
export interface FilePicker {
  pickEpub(): Promise<string | null>;
}

export function createTauriFilePicker(): FilePicker {
  return {
    async pickEpub(): Promise<string | null> {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'EPUB', extensions: ['epub'] }],
      });
      if (typeof selected !== 'string') {
        return null;
      }
      return selected;
    },
  };
}

/** 浏览器降级开发用:返回一个固定的演示源路径,由内存 Adapter 提供对应字节。 */
export function createInMemoryFilePicker(demoSourcePath: string): FilePicker {
  return {
    async pickEpub(): Promise<string | null> {
      return demoSourcePath;
    },
  };
}
