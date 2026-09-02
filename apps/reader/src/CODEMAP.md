# `apps/reader/src` — 阅读器前端源码

## 功能

`src/` 组合 React 工作台、稳定 Command、可序列化 Workspace State、阅读领域模型和不可持久化 Reader Runtime。应用入口由 `app/` 组装，用户可见工作台位于 `components/`，交互编排位于 `workbench/`，格式与持久化边界位于 `domain/`。

## 依赖其它文件夹

```text
src/
├── app/          应用启动、服务注入、工作台外观与布局策略
├── commands/     稳定 Command ID 与注册/执行基础设施
├── components/   工作台外壳、侧栏、阅读视图与对话框
├── domain/       Workspace、Library、Annotation、Reader 领域接口与适配器
├── workbench/    Store、Command 实现、Reader Runtime 与缓存编排
├── test/         Vitest 环境与 EPUB/PDF/Markdown 测试夹具
└── types/        前端共享类型
```

## 被谁依赖

- `main.tsx` 使用 `app/` 启动应用。
- `app/` 依赖 `commands/`、`domain/` 和 `workbench/` 组装 `AppServices`。
- `components/` 消费 `app/` 提供的服务、`commands/` 的稳定命令及 `workbench/` 的状态，不直接访问数据库或文件路径。
- `workbench/` 依赖 `domain/` 的窄接口，向 `app/` 和 `components/` 提供工作区状态与命令实现。

## 依赖方向与关键边界

```text
commands/  ← app/ → components/
                 ↘ workbench/ → domain/
```

TypeScript 前端拥有交互与阅读语义；SQLite、托管文件和平台完整性只经 `domain/` 的 typed Repository/Tauri 命令边界进入。Workspace State 只保存可序列化标签、位置和偏好，BookDocument、渲染器、选区及加载任务只属于 `workbench/readerRuntime.ts` 与其缓存，不能进入持久化状态。所有用户意图必须通过 `commands/` 的稳定 Command 表达。
