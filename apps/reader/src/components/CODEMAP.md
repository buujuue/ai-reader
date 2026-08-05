# `src/components` — 工作台外壳组件

## 功能

- `ActivityBar.tsx`：左侧活动栏，提供“切换主侧栏”按钮，执行 `workbench.togglePrimarySidebar` 命令。
- `PrimarySidebar.tsx`：书库侧栏，当前为静态占位（后续接入 EPUB/PDF/Markdown 导入）。
- `EditorArea.tsx`：编辑器区，当前显示空状态占位。
- `StatusBar.tsx`：底部状态栏，展示 `shellUiStore.statusMessage`。

## 依赖其它文件夹（树）

```
components/
├── app/AppServicesContext.tsx   useAppServices() 取 commands
├── commands/                    COMMAND_IDS 用于执行命令
└── workbench/
    ├── workspaceStore.ts        ActivityBar 读 primarySidebarVisible
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