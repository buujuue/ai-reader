# `src-tauri/src` — Tauri + Rust 平台核心源码

## 功能

Rust 平台核心：独占 SQLite、迁移、托管文件与导入状态机，透过 typed Tauri 命令向前端提供持久化能力。

- `lib.rs`：应用入口 `run()`，打开数据库、注入 `DatabaseHandle` 与 `LibraryPaths`，注册全部 typed 命令，启动时执行中断导入恢复。
- `main.rs`：二进制入口。
- `error.rs`：统一错误类型 `AppError` 与 io 错误分类。
- `fs.rs`：托管文件布局 `LibraryPaths`（暂存/书库目录）与流式复制 + SHA-256 完整内容指纹。
- `commands/`：typed Tauri 命令层；`workspace.rs`（工作区状态）、`import.rs`（导入/读取/列表/恢复）。命令层只通过 `DatabaseHandle::with_connection` 访问数据库。
- `db/`：`open_database` 顺序应用迁移、`DatabaseHandle` 窄接口；`workspace.rs` 实现 `WorkspaceRepository`；`import.rs` 实现 `ImportRepository`（stage 写 pending → inspect → commit 完成/去重 → recover 完成或回滚）。
- `db/migrations/`：编号递增的 SQL 迁移，当前 `0001_workspace.sql`、`0002_materials.sql`、`0003_import_pending.sql`。

## 依赖其它文件夹（树）

`src-tauri/src/` 内的模块均为同目录成员，不依赖 `apps/reader/src`（TS 前端）的任何文件；前端经 typed 命令与 DTO 反向调用命令层。

## 被谁依赖（树）

```
src-tauri/src/
└── 前端 apps/reader/src/
    ├── domain/library/tauriImportRepository.ts  经 invoke 调用导入命令
    └── domain/workspace/…                       经 invoke 调用工作区命令
```

## 依赖方向

前端不接触 SQLite、SQL、数据库路径或文件细节；Rust 命令层只经 `DatabaseHandle::with_connection` 访问数据库，不向前端暴露连接。Rust 持久化契约（真实 SQLite）与 TS 侧契约测试保持语义一致。