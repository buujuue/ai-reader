import { open } from '@tauri-apps/plugin-dialog';

/** 系统文件选择器窄接口。取消选择返回 null,不产生任何记录或暂存文件。 */
export interface FilePicker {
  /** 一次选择多份阅读材料(EPUB/PDF/Markdown);用户取消返回 null。 */
  pickBooks(): Promise<string[] | null>;
  /** 选择一张封面图片;用户取消返回 null。 */
  pickImage(): Promise<string | null>;
}

export function createTauriFilePicker(): FilePicker {
  return {
    async pickBooks(): Promise<string[] | null> {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [
          { name: '阅读材料', extensions: ['epub', 'pdf', 'md', 'markdown'] },
        ],
      });
      if (selected === null) {
        return null;
      }
      const paths = Array.isArray(selected) ? selected : [selected];
      return paths.filter((path): path is string => typeof path === 'string');
    },
    async pickImage(): Promise<string | null> {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        ],
      });
      if (selected === null) {
        return null;
      }
      return typeof selected === 'string' ? selected : null;
    },
  };
}

/** 浏览器降级开发用:返回固定的演示源路径数组,由内存 Adapter 提供对应字节。 */
export function createInMemoryFilePicker(demoSourcePaths: string[]): FilePicker {
  return {
    async pickBooks(): Promise<string[] | null> {
      return [...demoSourcePaths];
    },
    async pickImage(): Promise<string | null> {
      return null;
    },
  };
}