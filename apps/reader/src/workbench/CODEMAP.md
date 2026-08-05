# `src/workbench` — 工作台状态与命令实现

## 功能

- `workspaceStore.ts`：zustand Store，只持有可序列化的工作区状态（`primarySidebarVisible`）及 `hydrate`/`resetToDefault` 等动作；渲染器、选区等活对象不进入本 Store。
- `shellUiStore.ts`：外壳运行时反馈状态（`statusMessage`），不参与持久化。
- `libraryStore.ts`：书库可序列化状态（`materials`）与 `importing` 瞬时反馈。
- `workbenchCommands.ts`：工作台 Command 的唯一实现入口。`registerWorkbenchCommands` 向 Registry 注册 `workbench.togglePrimarySidebar`，先经 Repository `saveState` 持久化成功后才更新 Store，保证状态以 Rust 侧提交的事实为准；失败写入状态栏并抛错。
- `importBook.ts`：编排 `stage → inspect → commit` 的纯函数，取消选择返回 `null`，损坏文件抛领域化错误。
- `libraryCommands.ts`：书库 Command 唯一实现入口。`registerLibraryCommands` 注册 `library.importOne`（触发导入编排并刷新书库）与 `library.refresh`（列出书库）。
- 对应 `*.test.ts`：Store、命令与编排行为测试。

## 依赖其它文件夹（树）

```
workbench/
├── commands/            CommandRegistry 与 COMMAND_IDS
├── app/filePicker       FilePicker 窄接口
└── domain/
    ├── workspace/       WorkspaceRepository、WorkspaceState、
    │                    WORKSPACE_STATE_SCHEMA_VERSION
    └── library/         ImportRepository、ReadingMaterial、
                         EpubInspectError、inspectEpub
```

## 被谁依赖（树）

```
workbench/
├── app/
│   ├── bootstrap.ts     调用 registerWorkbenchCommands / registerLibraryCommands
│   └── App.tsx          useWorkspaceStore / useShellUiStore 状态恢复与错误反馈
└── components/          workspaceStore / shellUiStore / libraryStore 供外壳组件读取
```

## 依赖方向

`workbench/` 构建在 `commands/` 与 `domain/` 之上，向下游（`app/`、`components/`）提供 Store 与命令实现；它不反向依赖 UI 组件。
