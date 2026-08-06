# apps/reader/src — React + TypeScript 前端

阅读器前端。入口 `main.tsx`，全局样式 `index.css`。

## 目录内容

| 目录/文件 | 内容 |
| --- | --- |
| `app/` | `App.tsx` 应用外壳（启动恢复工作区、重启恢复阅读视图、卸载 flush）；`bootstrap.ts` 组装 `AppServices`（CommandRegistry + WorkspaceRepository + ImportRepository + FilePicker），按是否在 Tauri 运行时选择真实或内存 Adapter；`filePicker.ts` 系统文件选择器窄接口；`AppServicesContext.tsx` 服务上下文；`App.test.tsx` 应用级测试（含“打开 EPUB 并重启续读”验收）。 |
| `commands/` | `commandRegistry.ts`：Command Registry 与稳定 Command ID 注册机制。 |
| `components/` | 工作台外壳组件：`ActivityBar.tsx`（导入 EPUB + 切换主侧栏）、`PrimarySidebar.tsx`（书库列表，点击打开）、`EditorArea.tsx`（阅读标签栏 + 活动 ReadingView）、`ReadingView.tsx`（挂载 BookDocument 到容器，卸载 flush）、`StatusBar.tsx`。 |
| `domain/` | 领域层：`workspace/` 工作区（Editor Group、阅读视图、阅读位置）、`library/` 书库与导入（含内建最小 `EpubInspector`）、`reader/` 阅读文档（`BookDocument`、`EpubBookDocument`、`ReadingLocation`、Foliate 视图宿主、内容清洗器）、`tauriInvoke.ts` 共享 invoke 类型。 |
| `workbench/` | `workspaceStore.ts`（可序列化工作区状态）、`readerRuntime.ts`（活 BookDocument）、`positionPersister.ts`（阅读位置节流/flush）、`readerCommands.ts`（打开/翻页/关闭/恢复命令）、`workbenchCommands.ts` 命令注册、`libraryStore.ts`（书库）、`libraryCommands.ts`（导入/刷新命令）、`importBook.ts`（stage→inspect→commit 编排）、`shellUiStore.ts` 外壳 UI 状态，及对应测试。 |
| `test/setup.ts` | Vitest 测试环境配置。 |

## 约定

- 用户意图一律走 Command：UI 组件执行 Command，不在组件里另接行为逻辑；命令必须在 `commands/` 注册稳定 ID。
- 前端不接触 SQLite 表、SQL、数据库路径与文件细节；平台能力只经 typed Repository 接口调用 Rust 命令。
- 内存 Adapter 与 Tauri Adapter 必须运行同一份 `workspaceRepository.contract.ts` 契约测试；Repository 接口变化时同步更新契约与两个 Adapter。
- Workspace State 必须可序列化；Reader Runtime 活对象（视图、选区、加载任务）不得进入持久化状态。

## Readest 参照

实现任何前端模块（工作台布局、命令系统、存储适配、阅读视图等）前，先看 Readest 对应实现；有能直接复制的代码直接复制移植，并在 `docs/legal/third-party.md` 登记来源与许可。详见根 `AGENTS.md`。
