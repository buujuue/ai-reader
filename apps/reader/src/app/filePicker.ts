import { open } from '@tauri-apps/plugin-dialog';

/** 系统文件选择器窄接口。取消选择返回 null,不产生任何记录或暂存文件。 */
export interface FilePicker {
  /** 一次选择多份 EPUB;用户取消返回 null。 */
  pickEpubs(): Promise<string[] | null>;
}

export function createTauriFilePicker(): FilePicker {
  return {
    async pickEpubs(): Promise<string[] | null> {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [{ name: 'EPUB', extensions: ['epub'] }],
      });
      if (selected === null) {
        return null;
      }
      const paths = Array.isArray(selected) ? selected : [selected];
      return paths.filter((path): path is string => typeof path === 'string');
    },
  };
}

/** 浏览器降级开发用:返回固定的演示源路径数组,由内存 Adapter 提供对应字节。 */
export function createInMemoryFilePicker(demoSourcePaths: string[]): FilePicker {
  return {
    async pickEpubs(): Promise<string[] | null> {
      return [...demoSourcePaths];
    },
  };
}