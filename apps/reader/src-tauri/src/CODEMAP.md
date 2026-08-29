# `src-tauri/src` — Tauri + Rust 平台核心源码

## 功能

Rust 平台核心：独占 SQLite、迁移、托管文件与导入状态机，透过 typed Tauri 命令向前端提供持久化能力。

- `lib.rs`：应用入口 `run()`，打开数据库、注入 `DatabaseHandle` 与 `LibraryPaths`，注册全部 typed 命令，启动时执行中断导入恢复。
- `main.rs`：二进制入口。
- `error.rs`：统一错误类型 `AppError` 与 io 错误分类。
- `fs.rs`：托管文件布局 `LibraryPaths`（暂存/书库/自定义封面/来源封面/恢复快照/EPUB 推导目录缓存目录）、流式复制、SHA-256 完整内容指纹/文件校验、半开范围读取、同目录原子写入/原子替换复制与用户选择目标的 UTF-8 原子导出写入；恢复快照与派生缓存路径拒绝越界，保证托管读写不会越出私有目录。
- `managed_range.rs`：`managed-range` custom URI protocol；只接收 MaterialId 与半开范围，经现有 ImportRepository 校验活跃 ready 材料后返回二进制响应，不接受路径或任意文件系统请求。
- `commands/`：typed Tauri 命令层；`workspace.rs`（工作区状态）、`library_folder.rs`（文件夹树列表/新建/改名/递归删除，删除在 Rust Repository 的 SQLite 事务中清除材料归属）、`import.rs`（导入/读取/列表、唯一材料文件夹归属、托管副本可用状态、同指纹重新关联、恢复/正式 Markdown 保存/元数据覆盖、移除正文副本的回收站与永久清理，以及只按 MaterialId 提供名称/长度和 8 MiB 范围正文读取）、`epub.rs`（按 BookId 解析托管 EPUB、返回受能力门控的机械预取，并读写本地推导目录缓存）、`annotations.rs`（批注与用户选择目标的 Markdown 批注导出写入）、`markdown_recovery.rs`（恢复快照写入/列出/丢弃）、`backup.rs`（完整书库备份导出）。命令层只通过 `DatabaseHandle::with_connection` 访问数据库，批注导出写入不接触数据库。
- `epub.rs`：Rust 只读取 ZIP 中央目录、container.xml、OPF、NAV/NCX 和资源尺寸；不构造 BookDocument、TOC、spine 或 CFI，返回的协议带语义来源、平台和能力清单，前端不接受未通过 parity gate 的结果。前端 `domain/reader/tauriEpubNative.ts` 只经稳定 Tauri 命令消费该 DTO。
- `db/`：`open_database` 顺序应用迁移、`DatabaseHandle` 窄接口；`workspace.rs` 实现 schema 12 的 `WorkspaceRepository`，原样保存文件夹树展开状态和未归类区域展开状态；`folders.rs` 实现 `LibraryFolderRepository`，负责稳定 ID、显式父级、五层、名称清理和同级唯一性；`import.rs` 实现 `ImportRepository`，以 `IMMEDIATE` SQLite 事务串行化提交、按 `fingerprint + format` 唯一查重，保护重复提交并校验既有托管副本，在启动时校验 pending 托管副本指纹；材料归属用 nullable `folder_id` 受外键保护，移动只更新唯一归属并保留材料身份/文件/阅读数据，同指纹重新关联保留材料身份并原子恢复托管副本，普通删除把正文移入可恢复回收空间，永久清理级联删除数据库用户数据并移除派生目录缓存/迁移快照及回收正文、来源封面和自定义封面；`annotations.rs` 实现批注持久化；`markdown_recovery.rs` 管理版本化快照文件并按正式文档版本返回 available/conflict/corrupt 状态；`backup.rs` 以 SQLite Online Backup API 创建一致 v2 快照，按 64 KiB 缓冲流式写入 tar 归档并生成包含文件夹/材料归属的 manifest；恢复在暂存区校验层级、外键和 Workspace 树引用，v1 旧归档先清除文件夹数据再切换。
- `db/migrations/`：编号递增的 SQL 迁移，当前 `0001_workspace.sql` 至 `0011_material_library_folder.sql`；文件夹结构、材料归属和旧数据库迁移后的未归类默认值随 SQLite 一致快照进入完整备份。

## 依赖其它文件夹（树）

`src-tauri/src/` 内的模块均为同目录成员，不依赖 `apps/reader/src`（TS 前端）的任何文件；前端经 typed 命令与 DTO 反向调用命令层。

## 被谁依赖（树）

```
src-tauri/src/
└── 前端 apps/reader/src/
    ├── domain/library/tauriImportRepository.ts  经 invoke 调用导入、材料归属、恢复与托管范围读取命令
    ├── domain/library/tauriLibraryFolderRepository.ts 经 invoke 调用文件夹列表/新建/改名/递归删除命令
    ├── domain/workspace/…                       经 invoke 调用工作区命令
    └── domain/reader/tauriDerivedTocCache.ts    经 invoke 调用 EPUB 推导目录缓存命令
```

## 依赖方向

前端不接触 SQLite、SQL、数据库路径或文件细节；Rust 命令层只经 `DatabaseHandle::with_connection` 访问数据库，不向前端暴露连接。EPUB 推导目录通过 `tauriDerivedTocCache.ts` 的 typed 命令使用 Rust 私有派生缓存目录，不进入备份或同步。Rust 持久化契约（真实 SQLite）与 TS 侧契约测试保持语义一致。
<!-- 完整书库恢复由 db/backup.rs 负责隔离校验、快照切换与启动回滚；lib.rs 在打开 SQLite 前执行恢复器。 -->
## 完整书库恢复

`commands/backup.rs` 的恢复命令只调用 `DatabaseHandle::restore_backup` 生命周期 API；该 API 是普通 `with_connection` 之外的唯一例外，用于安全释放 SQLite 句柄、执行文件切换并恢复连接。`db/backup.rs` 在 `stash` 中保存阶段状态，启动时由 `lib.rs` 在打开数据库前处理回滚。
