# apps/reader/src-tauri — Tauri + Rust 平台核心

Cargo workspace 成员（见根 `Cargo.toml`）。Rust 拥有持久化、文件和平台完整性；不理解 React 焦点、标签布局或选区。

## 目录内容

| 路径 | 内容 |
| --- | --- |
| `src/lib.rs` | 应用入口 `run()`：在 app data 目录下创建 `ai-reader.db`，打开 SQLite、注入 `DatabaseHandle` 与 `LibraryPaths`，注册 typed 命令，启动时恢复中断导入 |
| `src/main.rs` | 二进制入口 |
| `src/error.rs` | 统一错误类型 `AppError` |
| `src/fs.rs` | 托管文件布局 `LibraryPaths`（暂存/书库目录）、流式复制 + SHA-256 指纹 |
| `src/commands/` | typed Tauri 命令；`workspace.rs` 提供 `load_workspace_state` / `save_workspace_state`；`import.rs` 提供 `stage_import` / `read_staged_file` / `commit_import` / `list_materials` / `read_managed_file` / `recover_imports` |
| `src/db/` | `open_database`（WAL + foreign_keys pragma、顺序应用迁移）、`DatabaseHandle` 窄接口；`workspace.rs` 实现 `WorkspaceRepository`（含 Editor Group / 阅读视图 / 阅读位置 DTO）；`import.rs` 实现 `ImportRepository`（stage → inspect → commit，含 `read_managed` 读取托管文件） |
| `src/db/migrations/` | 编号递增的 SQL 迁移文件，当前 `0001_workspace.sql`、`0002_materials.sql` |
| `capabilities/default.json` | 最小权限 Capability（含 导入所需的 `dialog:default`） |
| `tauri.conf.json` | 窗口、产品标识与打包配置 |
| `icons/` | 应用图标，由 `scripts/generate-icons.mjs` 生成 |
| `build.rs` / `Cargo.toml` | 构建配置与 Rust 依赖（tauri、tauri-plugin-dialog、rusqlite、sha2、uuid、base64、serde） |

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
