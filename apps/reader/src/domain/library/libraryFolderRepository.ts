import type { LibraryFolder } from './libraryFolder';

export interface LibraryFolderDeletionResult {
  /** 已从书库树中移除的文件夹 ID,包含传入目标及全部后代。 */
  deletedFolderIds: string[];
}

export interface InMemoryDeletionTransaction {
  commit(): void;
  rollback(): void;
}

/** 书库文件夹的 typed Repository 边界;不暴露 SQL、数据库路径或文件系统。 */
export interface LibraryFolderRepository {
  /** 列出全部文件夹;空文件夹也必须返回。 */
  listFolders(): Promise<LibraryFolder[]>;
  /** 新建顶层或子文件夹; parentId 为 null 表示顶层。 */
  createFolder(name: string, parentId: string | null): Promise<LibraryFolder>;
  /** 改名但保持原父级不变。 */
  renameFolder(folderId: string, name: string): Promise<LibraryFolder>;
  /** 递归删除文件夹子树;材料归属由 Adapter 在同一操作中转为未归类。 */
  deleteFolder(folderId: string): Promise<LibraryFolderDeletionResult>;
}
