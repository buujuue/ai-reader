# `src/commands` — Command Registry

## 功能

- `commandRegistry.ts`：核心命令机制。
  - `COMMAND_IDS`：稳定 Command ID 的单一来源（如 `workbench.togglePrimarySidebar`）。
  - `CommandRegistry`：注册/执行命令，支持 `register`、`has`、`execute`；重复注册抛 `DuplicateCommandError`，未注册执行抛 `UnknownCommandError`。
  - 所有按钮、菜单、键盘、触摸 Adapter 都通过稳定 Command ID 执行用户意图，避免同一意图多套逻辑。
- `commandRegistry.test.ts`：Registry 行为测试。

## 依赖其它文件夹（树）

无（零依赖，最底层的基础设施）。

## 被谁依赖（树）

```
commands/
├── app/                    bootstrap.ts 实例化 CommandRegistry
├── workbench/              workbenchCommands.ts 注册命令
└── components/             经 useAppServices().commands 执行命令
```

## 依赖方向

`commands/` 不依赖任何其它 `src/` 文件夹，是各聚合物（app、workbench）与 UI 组件共同依赖的底层基础。