# `src-tauri/src` — Tauri + Rust 平台核心源码

## 功能

Rust 平台核心：独占 SQLite、迁移、托管文件与导入状态机，透过 typed Tauri 命令向前端提供持久化能力。

- `lib.rs`：应用入口 `run()`，打开数据库、注入 `DatabaseHandle` 与 `LibraryPaths`，注册全部 typed 命令，启动时执行中断导入恢复。
- `main.rs`：二进制入口。
- `error.rs`：统一错误类型 `AppError` 与 io 错误分类。
- `fs.rs`：托管文件布局 `LibraryPaths`（暂存/书库/封面/恢复快照目录）、流式复制、SHA-256 完整内容指纹/文件校验、同目录原子写入与用户选择目标的 UTF-8 原子导出写入；恢复快照路径拒绝绝对路径及目录分隔符，保证托管读写不会越出私有目录。
- `commands/`：typed Tauri 命令层；`workspace.rs`（工作区状态）、`import.rs`（导入/读取/列表/恢复/正式 Markdown 保存/元数据覆盖/回收站）、`annotations.rs`（批注与用户选择目标的 Markdown 批注导出写入）、`markdown_recovery.rs`（恢复快照写入/列出/丢弃）、`backup.rs`（完整书库备份导出）。命令层只通过 `DatabaseHandle::with_connection` 访问数据库，批注导出写入不接触数据库。
- `db/`：`open_database` 顺序应用迁移、`DatabaseHandle` 窄接口；`workspace.rs` 实现 `WorkspaceRepository`；`import.rs` 实现 `ImportRepository`，以 `IMMEDIATE` SQLite 事务串行化提交、按 `fingerprint + format` 唯一查重，保护重复提交并校验既有托管副本，在启动时校验 pending 托管副本指纹；`annotations.rs` 实现批注持久化；`markdown_recovery.rs` 管理版本化快照文件并按正式文档版本返回 available/conflict/corrupt 状态；`backup.rs` 以 SQLite Online Backup API 创建一致快照，按 64 KiB 缓冲流式写入 tar 归档并生成版本化 manifest。
- `db/migrations/`：编号递增的 SQL 迁移，当前 `0001_workspace.sql` 至 `0008_import_identity.sql`；最后一项先清理历史重复 ready 身份，再建立 `fingerprint + format` 唯一约束，恢复快照按 ADR-0006 保存在文件系统，不新增数据库表。

## 依赖其它文件夹（树）

`src-tauri/src/` 内的模块均为同目录成员，不依赖 `apps/reader/src`（TS 前端）的任何文件；前端经 typed 命令与 DTO 反向调用命令层。

## 被谁依赖（树）

```
src-tauri/src/
└── 前端 apps/reader/src/
    ├── domain/library/tauriImportRepository.ts  经 invoke 调用导入与 Markdown 恢复命令
    └── domain/workspace/…                       经 invoke 调用工作区命令
```

## 依赖方向

前端不接触 SQLite、SQL、数据库路径或文件细节；Rust 命令层只经 `DatabaseHandle::with_connection` 访问数据库，不向前端暴露连接。Rust 持久化契约（真实 SQLite）与 TS 侧契约测试保持语义一致。
<!-- 完整书库恢复由 db/backup.rs 负责隔离校验、快照切换与启动回滚；lib.rs 在打开 SQLite 前执行恢复器。 -->
## 完整书库恢复

`commands/backup.rs` 的恢复命令只调用 `DatabaseHandle::restore_backup` 生命周期 API；该 API 是普通 `with_connection` 之外的唯一例外，用于安全释放 SQLite 句柄、执行文件切换并恢复连接。`db/backup.rs` 在 `stash` 中保存阶段状态，启动时由 `lib.rs` 在打开数据库前处理回滚。
