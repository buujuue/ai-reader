# `src-tauri/src/db` — SQLite 持久化模块

## 功能

该目录拥有 AI Reader 的 SQLite 数据事实与恢复协议。模块只接受 Rust 领域参数，不向 TypeScript 暴露连接、SQL 或数据库路径。

- `mod.rs`：打开数据库、按编号应用迁移，并通过 `DatabaseHandle` 提供普通连接访问和整库恢复时的连接生命周期切换。
- `migrations/`：只向前追加的 schema 迁移；当前包含 Workspace、材料、批注、回收站、版本迁移和书库文件夹/材料归属结构。
- `workspace.rs`：保存与加载可序列化 Workspace State，包括标签、阅读位置、侧栏状态和书库树展开状态。
- `import.rs`：托管材料导入、元数据、封面、回收站、Markdown 正式保存和显式版本迁移。
- `folders.rs`：书库文件夹稳定 ID、父子层级、名称规则、同级唯一性和递归删除事务；文件夹命名规则由本模块拥有，备份校验复用其已存储名称校验。
- `annotations.rs`：材料级批注、tombstone、恢复和批量事务。
- `markdown_recovery.rs`：未正式保存 Markdown 的版本化恢复快照。
- `backup.rs`：完整书库 v2 tar/SQLite 备份、v1 兼容降级、manifest/数据库/文件指纹校验、Workspace 树校验、暂存、安全快照、原子切换与启动回滚。

## 依赖其它文件夹

`db/` 依赖同级 `../fs.rs` 的托管文件路径、流式复制和原子文件操作，以及 `../error.rs` 的统一中文错误；`backup.rs` 依赖 `folders.rs` 的文件夹名称规则。它不依赖前端 `apps/reader/src`。

## 被谁依赖

```
src-tauri/src/commands/
├── workspace.rs ───────► db/workspace.rs
├── library_folder.rs ──► db/folders.rs
├── import.rs ───────────► db/import.rs
├── annotations.rs ─────► db/annotations.rs
├── markdown_recovery.rs ► db/markdown_recovery.rs
└── backup.rs ───────────► db/backup.rs / DatabaseHandle
```

`lib.rs` 在打开数据库前调用备份恢复器处理未完成切换；前端只通过这些 typed Command 使用本目录能力。

## 依赖方向与边界

`commands/` 负责参数接收和 DTO 返回，`db/` 负责事务与领域完整性，`fs.rs` 负责私有文件边界。备份恢复是唯一需要释放旧 SQLite 连接后切换数据库文件的路径；普通读写继续通过 `DatabaseHandle::with_connection`。
