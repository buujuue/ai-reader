# apps/reader/src-tauri — Tauri + Rust 平台核心

Cargo workspace 成员（见根 `Cargo.toml`）。Rust 拥有持久化、文件和平台完整性；不理解 React 焦点、标签布局或选区。

## 目录内容

| 路径 | 内容 |
| --- | --- |
| `src/lib.rs` | 应用入口 `run()`：在 app data 目录下创建 `ai-reader.db`，打开 SQLite、注入 `DatabaseHandle` 与 `LibraryPaths`，注册 typed 命令，启动时恢复中断导入 |
| `src/main.rs` | 二进制入口 |
| `src/error.rs` | 统一错误类型 `AppError` |
| `src/fs.rs` | 托管文件布局 `LibraryPaths`（暂存/书库/封面/恢复快照/版本迁移快照/EPUB 推导目录缓存目录）、恢复路径越界校验、派生缓存键哈希隔离、半开范围读取、原子写入、用户选择目标的 UTF-8 原子导出写入、流式复制 + SHA-256 指纹 |
| `src/commands/` | typed Tauri 命令；`workspace.rs` 提供工作区命令；`import.rs` 提供导入、书库、回收站、元数据、`save_markdown`、显式版本迁移以及只按 MaterialId 的托管材料信息/范围读取命令；`epub.rs` 提供受 parity gate 保护的 EPUB 机械预取命令，以及推导目录缓存的读写命令；`annotations.rs` 提供批注列表、批量保存、软删除/恢复命令与 `write_annotation_markdown` 导出写入命令；`markdown_recovery.rs` 提供恢复快照命令；`backup.rs` 提供 `export_library_backup` 与 `restore_library_backup` 完整备份命令 |
| `src/managed_range.rs` | `managed-range` custom URI protocol；Windows PDF 通过 MaterialId 和半开范围接收 Rust 二进制响应，非 Windows 保持编译但前端不选择 |
| `src/db/` | `open_database`（WAL + foreign_keys pragma、顺序应用迁移）、`DatabaseHandle` 窄接口；`workspace.rs` 实现工作区；`import.rs` 实现导入、书库、回收站、正式 Markdown 保存与显式 EPUB 版本迁移快照/提交/恢复；`annotations.rs` 实现材料级批注、tombstone、显式恢复与批量 SQLite 事务；`markdown_recovery.rs` 管理恢复快照；`backup.rs` 创建一致 SQLite 快照并按流式归档写出 manifest、材料与封面，同时负责隔离校验、空间预检、快照切换与启动回滚 |
| `src/db/migrations/` | 编号递增的 SQL 迁移文件，当前 `0001_workspace.sql` 至 `0009_annotation_recovery_state.sql` |
| `capabilities/default.json` | 最小权限 Capability（含关闭前等待 flush 所需的 `core:window:allow-destroy`、导入/备份所需的 `dialog:allow-open`/`dialog:allow-save` 与外部链接 `opener:allow-open-url`） |
| `tauri.conf.json` | 窗口、产品标识与打包配置 |
| `icons/` | 应用图标，由 `scripts/generate-icons.mjs` 生成 |
| `src/epub.rs` / `Cargo.toml` | EPUB 机械预取与 parity DTO；依赖 `zip`、`quick-xml`、`percent-encoding`，不在 Rust 侧实现 EPUB 语义 |

## 命令

```powershell
cargo test                                              # 迁移与 workspace 持久化契约
cargo clippy --workspace --all-targets -- -D warnings
```

## 约定

- 迁移只向前加：新增编号递增的 SQL 文件并注册进 `MIGRATIONS`，不改写已发布迁移；`schema_migrations` 记录已应用版本。
- 对前端暴露的平台能力一律走 typed 命令，返回 `Result<_, AppError>`；命令层只通过 `DatabaseHandle::with_connection` 访问数据库，不暴露连接本身。
- 新增命令必须同步在 `lib.rs` 的 `invoke_handler` 注册，并核对 `capabilities/` 权限最小化。
- Rust 侧持久化契约（真实 SQLite）与 TS 侧契约测试保持语义一致。

## Readest 参照

实现任何持久化、导入、文件管理类能力前，先看 Readest 对应实现；有能直接复制的代码直接复制移植，并在 `docs/legal/third-party.md` 登记来源与许可。详见根 `AGENTS.md`。
> 完整书库恢复是命令层的唯一数据库句柄生命周期例外：`restore_library_backup` 必须通过 `DatabaseHandle::restore_backup` 释放旧 SQLite 连接、切换文件并重新打开新库；普通数据访问仍一律通过 `with_connection`。
