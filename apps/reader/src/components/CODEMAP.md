# `src/components` — 工作台外壳组件

## 功能

- `ActivityBar.tsx`：左侧活动栏，提供“导入 EPUB”按钮（执行 `library.importOne`）与“切换主侧栏”按钮（执行 `workbench.togglePrimarySidebar`）。
- `PrimarySidebar.tsx`：书库侧栏，列出 `libraryStore.materials`；空状态提示导入；非空时按阅读材料渲染书名与作者。
- `EditorArea.tsx`：编辑器区，当前显示空状态占位。
- `StatusBar.tsx`：底部状态栏，展示 `shellUiStore.statusMessage`。

## 依赖其它文件夹（树）

```
components/
├── app/AppServicesContext.tsx   useAppServices() 取 commands
├── commands/                    COMMAND_IDS 用于执行命令
└── workbench/
    ├── workspaceStore.ts        ActivityBar 读 primarySidebarVisible
    ├── libraryStore.ts          PrimarySidebar 读 materials;ActivityBar 读 importing
    └── shellUiStore.ts          StatusBar 读 statusMessage
```

## 被谁依赖（树）

```
app/App.tsx  ──►  components/
                  ├── ActivityBar
                  ├── PrimarySidebar
                  ├── EditorArea
                  └── StatusBar
```

## 依赖方向

`components/` 只消费状态与命令，不直接触碰持久化/Repository；用户意图一律经 Command 表达，由 `workbench/` 的命令实现处理。
