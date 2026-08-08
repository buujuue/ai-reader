# `src/components` — 工作台外壳组件

## 功能

- `ActivityBar.tsx`：左侧活动栏，提供“导入 EPUB”按钮（执行 `library.importOne`）与“切换主侧栏”按钮（执行 `workbench.togglePrimarySidebar`）。
- `PrimarySidebar.tsx`：书库侧栏，列出 `libraryStore.materials`；点击某本书执行 `library.openBook` 打开阅读标签；每本书的铅笔按钮执行 `shellUiStore.openMetadataEditor` 打开元数据编辑器；空状态提示导入。
- `EditorArea.tsx`：编辑器区，渲染阅读标签栏（tablist）与活动 `ReadingView`；无标签时显示空状态占位；关闭按钮执行 `reader.closeView`。
- `ReadingView.tsx`：单个阅读视图正文。把活动视图的 `BookDocument` 通过 `mountViewDocument` 挂载到自身容器，卸载时 flush 位置并释放渲染器；Reader 外部不直接操作 Foliate View。
- `MetadataEditorDialog.tsx`：元数据编辑器对话框。覆盖标题/作者/封面并一键恢复来源元数据；所有变更经 `library.updateMetadata` / `library.setCover` / `library.removeCover` / `library.restoreMetadata` 命令执行，封面预览经 `importRepository.readCover` 读取。
- `StatusBar.tsx`：底部状态栏，展示 `shellUiStore.statusMessage`。

## 依赖其它文件夹（树）

```
components/
├── app/AppServicesContext.tsx   useAppServices() 取 commands 与 Repository
├── commands/                    COMMAND_IDS 用于执行命令
├── domain/reader/               viewHost 类型(测试用伪宿主)
└── workbench/
    ├── workspaceStore.ts        ActivityBar 读 primarySidebarVisible;EditorArea 读 editorGroups
    ├── readerRuntime.ts         ReadingView 读 documents
    ├── readerCommands.ts        ReadingView 调 mountViewDocument
    ├── libraryStore.ts          PrimarySidebar 读 materials;ActivityBar 读 importing
    └── shellUiStore.ts          StatusBar 读 statusMessage;PrimarySidebar 开元数据编辑器
```

## 被谁依赖（树）

```
app/App.tsx  ──►  components/
                  ├── ActivityBar
                  ├── PrimarySidebar
                  ├── EditorArea
                  │     └─ ► ReadingView
                  └── StatusBar
```

## 依赖方向

`components/` 只消费状态与命令，不直接触碰持久化/Repository；用户意图一律经 Command 表达，由 `workbench/` 的命令实现处理。阅读视图的渲染器挂载是渲染职责，经 `mountViewDocument` 窄函数完成，不泄漏 Foliate View 到组件。