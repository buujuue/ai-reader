# `src/commands` — Command Registry

## 功能

- 主要阅读材料与批注面板使用稳定命令 `workbench.setPrimaryMaterial`、`workbench.toggleAnnotationSidebar`、`annotation.goTo` 和 `annotation.createPdfArea`，组件不直接改写工作区持久化状态。

- `commandRegistry.ts`：核心命令机制。
  - `COMMAND_IDS`：稳定 Command ID 的单一来源（如 `workbench.togglePrimarySidebar`、`workbench.saveState`、`library.importOne`、`library.refresh`、`library.openBook`、`library.exportBackup`、`reader.activateView`、`reader.nextPage`、`reader.prevPage`、`reader.closeView`、`reader.restoreView`、`reader.typography.apply`、`reader.typography.reset`、`reader.typography.setGlobal`、`annotation.createPdfArea`）。
  - `CommandRegistry`：注册/执行命令，支持 `register`、`has`、`execute`；重复注册抛 `DuplicateCommandError`，未注册执行抛 `UnknownCommandError`。
  - 所有按钮、菜单、键盘、触摸 Adapter 都通过稳定 Command ID 执行用户意图，避免同一意图多套逻辑。
- `commandRegistry.test.ts`：Registry 行为测试。

## 依赖其它文件夹（树）

无（零依赖，最底层的基础设施）。

## 被谁依赖（树）

```
commands/
├── app/                    bootstrap.ts 实例化 CommandRegistry
├── workbench/              workbenchCommands.ts / libraryCommands.ts / readerCommands.ts 注册命令
└── components/             经 useAppServices().commands 执行命令
```

## 依赖方向

`commands/` 不依赖任何其它 `src/` 文件夹，是各聚合物（app、workbench）与 UI 组件共同依赖的底层基础。
## 多标签运行时边界

`reader.activateView` 是标签切换的唯一命令入口，负责让 Workspace Store 保留标签状态，并让 Reader Runtime 只保留活动标签的活对象。
