# `src/domain/workspace` — 工作区（Workspace）子域

## 功能

- `workspaceState.ts`：可序列化的 `WorkspaceState`（`schemaVersion` + `primarySidebarVisible`）与 `DEFAULT_WORKSPACE_STATE` 默认值、`WORKSPACE_STATE_SCHEMA_VERSION`。
- `workspaceRepository.ts`：typed Repository 接口（`loadState` / `saveState`），是前端调用 Rust 持久化能力的窄边界。
- `tauriWorkspaceRepository.ts`：Tauri Adapter，经 `@tauri-apps/api/core` 的 `invoke` 调用 `load_workspace_state` / `save_workspace_state` 命令；`TauriInvoke` 可注入伪后端供测试，附 `assertWorkspaceStateShape` 载荷校验。
- `inMemoryWorkspaceRepository.ts`：内存 Adapter，浏览器降级开发用。
- `workspaceRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的契约测试。
- 对应 `*.test.ts`：Adapter 行为测试。

## 依赖其它文件夹（树）

无（`domain/workspace` 不依赖其它 `src/` 文件夹）。

## 被谁依赖（树）

```
domain/workspace/
├── app/
│   ├── bootstrap.ts    选择并创建 Repository
│   └── App.tsx         调用 loadState 恢复状态
└── workbench/
    ├── workbenchCommands.ts   调用 saveState 持久化
    └── workspaceStore.ts      引用 WorkspaceState 与默认状态
```

## 依赖方向

该子域是持久化契约的家：内存 Adapter 与 Tauri Adapter 必须运行同一份 `workspaceRepository.contract.ts` 契约测试；接口变化时同步更新契约与两个 Adapter。Rust 侧在真实 SQLite 上运行镜像契约。