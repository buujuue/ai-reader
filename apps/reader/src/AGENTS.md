# apps/reader/src — React + TypeScript 前端

阅读器前端。入口 `main.tsx`，全局样式 `index.css`。

## 目录内容

| 目录/文件 | 内容 |
| --- | --- |
| `app/` | `App.tsx` 应用外壳；`bootstrap.ts` 组装 `AppServices`（CommandRegistry + WorkspaceRepository），按是否在 Tauri 运行时选择真实或内存 Adapter；`AppServicesContext.tsx` 服务上下文；`App.test.tsx` 应用级测试。 |
| `commands/` | `commandRegistry.ts`：Command Registry 与稳定 Command ID 注册机制。 |
| `components/` | 工作台外壳组件：`ActivityBar.tsx`、`PrimarySidebar.tsx`、`EditorArea.tsx`、`StatusBar.tsx`。 |
| `domain/workspace/` | `workspaceState.ts` 可序列化的 Workspace State；`workspaceRepository.ts` typed Repository 接口；`tauriWorkspaceRepository.ts` 与 `inMemoryWorkspaceRepository.ts` 两个 Adapter；`workspaceRepository.contract.ts` 共享契约测试。 |
| `workbench/` | `workspaceStore.ts`（zustand）、`workbenchCommands.ts` 命令注册、`shellUiStore.ts` 外壳 UI 状态，及对应测试。 |
| `test/setup.ts` | Vitest 测试环境配置。 |

## 约定

- 用户意图一律走 Command：UI 组件执行 Command，不在组件里另接行为逻辑；命令必须在 `commands/` 注册稳定 ID。
- 前端不接触 SQLite 表、SQL、数据库路径与文件细节；平台能力只经 typed Repository 接口调用 Rust 命令。
- 内存 Adapter 与 Tauri Adapter 必须运行同一份 `workspaceRepository.contract.ts` 契约测试；Repository 接口变化时同步更新契约与两个 Adapter。
- Workspace State 必须可序列化；Reader Runtime 活对象（视图、选区、加载任务）不得进入持久化状态。

## Readest 参照

实现任何前端模块（工作台布局、命令系统、存储适配、阅读视图等）前，先看 Readest 对应实现；有能直接复制的代码直接复制移植，并在 `docs/legal/third-party.md` 登记来源与许可。详见根 `AGENTS.md`。
