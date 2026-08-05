# `src/domain` — 领域模型与持久化边界

## 功能

领域层定义可序列化的领域模型与 typed Repository 接口，是前端与 Rust 平台核心之间的契约边界。当前仅含 `workspace/` 工作区子域。

## 子目录

- `workspace/`：工作区状态模型、Repository 接口及内存/Tauri 两个 Adapter。详见 `workspace/CODEMAP.md`。

## 依赖其它文件夹（树）

无（领域层不依赖 UI、命令或工作台组件）。

## 被谁依赖（树）

```
domain/
├── app/bootstrap.ts                创建 Repository
└── workbench/
    ├── workbenchCommands.ts        经 Repository 持久化状态
    └── workspaceStore.ts           引用 WorkspaceState 与默认状态
```

## 依赖方向

`domain/` 是最内层、无外部依赖的深模块；它定义契约，由 `workbench/` 与 `app/` 消费。前端不接触 SQLite 表、SQL 或数据库路径，平台能力只经 `domain/` 的 typed Repository 接口调用 Rust 命令。