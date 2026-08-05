# `src/workbench` — 工作台状态与命令实现

## 功能

- `workspaceStore.ts`：zustand Store，只持有可序列化的工作区状态（`primarySidebarVisible`）及 `hydrate`/`resetToDefault` 等动作；渲染器、选区等活对象不进入本 Store。
- `shellUiStore.ts`：外壳运行时反馈状态（`statusMessage`），不参与持久化。
- `workbenchCommands.ts`：工作台 Command 的唯一实现入口。`registerWorkbenchCommands` 向 Registry 注册 `workbench.togglePrimarySidebar`，先经 Repository `saveState` 持久化成功后才更新 Store，保证状态以 Rust 侧提交的事实为准；失败写入状态栏并抛错。
- 对应 `*.test.ts`：Store 与命令行为测试。

## 依赖其它文件夹（树）

```
workbench/
├── commands/            CommandRegistry 与 COMMAND_IDS
└── domain/workspace/    WorkspaceRepository、WorkspaceState、
                         WORKSPACE_STATE_SCHEMA_VERSION
```

## 被谁依赖（树）

```
workbench/
├── app/
│   ├── bootstrap.ts     调用 registerWorkbenchCommands 注册命令
│   └── App.tsx          useWorkspaceStore / useShellUiStore 状态恢复与错误反馈
└── components/          workspaceStore / shellUiStore 供外壳组件读取
```

## 依赖方向

`workbench/` 构建在 `commands/` 与 `domain/workspace/` 之上，向下游（`app/`、`components/`）提供 Store 与命令实现；它不反向依赖 UI 组件。