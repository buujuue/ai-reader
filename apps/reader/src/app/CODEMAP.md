# `src/app` — 应用外壳与依赖组装

## 功能

- `main.tsx`（位于 `src/` 根，不在本目录）通过 `createRoot` 挂载，组合 `AppServicesProvider` 与 `App`。
- `bootstrap.ts`：组装 `AppServices`（`CommandRegistry` + `WorkspaceRepository`）。`isTauriRuntime()` 检测 `__TAURI_INTERNALS__`，据此选择 Tauri Adapter 或内存 Adapter；`createAppServices()` 注册工作台命令。
- `AppServicesContext.tsx`：React 上下文，向组件树提供 `AppServices`；`useAppServices()` 供任意组件取用。
- `App.tsx`：工作台顶层外壳，启动时调用 `workspaceRepository.loadState()` 恢复工作区状态，并按 `primarySidebarVisible` 组合 `ActivityBar`、`PrimarySidebar`、`EditorArea`、`StatusBar`。
- `App.test.tsx`：应用级测试。

## 依赖其它文件夹（树）

```
app/
├── commands/           创建 CommandRegistry
├── domain/workspace/   创建并用 WorkspaceRepository 加载状态
├── workbench/          registerWorkbenchCommands 注册命令；
│                       useWorkspaceStore / useShellUiStore 状态恢复
└── components/         渲染外壳组件
```

## 被谁依赖（树）

```
src/ main.tsx  ──►  app/
                    ├── App
                    ├── AppServicesProvider
                    └── createAppServices
```

## 依赖方向

`app/` 是组合根：它依赖 `commands/`、`domain/`、`workbench/`、`components/`，但上述目录不反向依赖 `app/`（`useAppServices` 例外，供组件消费服务）。
