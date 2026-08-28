import type { LibraryFolder } from './libraryFolder';

/** 书库文件夹的 typed Repository 边界;不暴露 SQL、数据库路径或文件系统。 */
export interface LibraryFolderRepository {
  /** 列出全部文件夹;空文件夹也必须返回。 */
  listFolders(): Promise<LibraryFolder[]>;
  /** 新建顶层或子文件夹; parentId 为 null 表示顶层。 */
  createFolder(name: string, parentId: string | null): Promise<LibraryFolder>;
  /** 改名但保持原父级不变。 */
  renameFolder(folderId: string, name: string): Promise<LibraryFolder>;
}
