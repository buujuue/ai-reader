# `src/components` — 工作台外壳组件

## 功能

- `AnnotationSidebar.tsx`：主要阅读材料的材料级批注面板，支持引文/笔记筛选、失联标识，以及通过 `annotation.goTo` 跳转正文或 PDF 区域。

- `SelectionToolbar.tsx`：监听正文文本选区与 PDF 扫描页区域选区；按选区类型显示高亮动作，经 `annotation.createHighlight` 或 `annotation.createPdfArea` Command 创建批注，不把选区活对象写入工作区状态。

- `ActivityBar.tsx`：左侧活动栏，提供“导入 EPUB”按钮（执行 `library.importOne`）、“切换主侧栏”按钮（执行 `workbench.togglePrimarySidebar`）与“切换目录”按钮（执行 `workbench.toggleToc`）。
- `PrimarySidebar.tsx`：书库侧栏，紧凑封面网格展示 `libraryStore.materials`，顶部搜索框按标题/作者即时筛选；点击或键盘激活封面卡片执行 `library.openBook` 打开阅读标签；卡片右上角「编辑」执行 `shellUiStore.openMetadataEditor` 打开元数据编辑器、「移入回收站」执行 `library.trash`；底部回收站区块展示 `libraryStore.trashedMaterials`，可「恢复」（`library.restoreFromTrash`）与「永久删除」（`shellUiStore.openPurgeConfirm` 打开确认对话框）；含书库空、筛选无结果两类空态。
- `MaterialCover.tsx`：封面渲染，经 `importRepository.readCover` 读取托管封面字节并以对象 URL 渲染；默认 IntersectionObserver 懒加载（进入视口才解码）、卸载时 revoke 释放；无封面「暂无封面」与加载失败「封面加载失败」两种占位。
- `EditorArea.tsx`：编辑器区，按持久化拆分方向渲染最多两个 Editor Group；每组渲染独立标签栏（tablist）与活动 `ReadingView`。点击组、标签和控件通过 Command 维护当前组与 Runtime；无标签时显示空状态占位；关闭按钮执行 `reader.closeView`；「阅读排版」按钮打开 `ReaderSettingsDialog`；Markdown 材料显示「进入/退出源码模式」按钮执行 `markdown.toggleSourceMode`；提供向右/向下拆分按钮。
- `ReadingView.tsx`：单个阅读视图正文。把所属组活动视图的 `BookDocument` 通过 `mountViewDocument` 挂载到自身容器；标签切换和关闭时由 Reader Command 统一 flush 并释放同组非活动 Runtime，组件不直接管理 Runtime 生命周期；仅当前组活动视图监听窗口级键盘，内容文档的滚轮/点击/触摸按视图桥接到 `ReadingInputController`，统一收敛到 `reader.nextPage`/`reader.prevPage` Command。Markdown 视图处于源码模式时渲染 `MarkdownSourceEditor` 而非阅读容器。Reader 外部不直接操作 Foliate View。
- `MarkdownSourceEditor.tsx`：Markdown 源码模式编辑器（ADR-0009）。仅在首次进入源码模式时动态加载 CodeMirror 6（高亮、撤销重做、查找替换），读写共享 `MarkdownDocumentSession` 缓冲区，并把用户确认恢复的外部会话文本同步到已挂载编辑器；程序化同步不会回流为用户编辑 Command，避免放弃后重新制造快照。绑定 Ctrl/Cmd+S 执行 `markdown.save`，由 `ReadingView` 在 `sourceMode` 时渲染。
- `MarkdownDirtyCloseDialog.tsx`：脏 Markdown 文档关闭/退出源码模式确认对话框。提供「保存」「放弃」「取消」，分别执行 `markdown.closeDirty` 的 save/discard/cancel；由 `shellUiStore.markdownDirtyCloseViewId` 控制开关。
- `MarkdownRecoveryDialog.tsx`：启动恢复对话框。逐份展示 available/conflict/corrupt 快照；有效或冲突快照可经 `markdown.recovery.resolve` 载入为未保存缓冲区，损坏快照只允许丢弃，绝不自动覆盖正式内容。
- `SearchBar.tsx`：当前阅读视图的搜索栏（顶部覆盖层）。输入经防抖后执行 `reader.search.run`，大小写开关执行 `reader.search.toggleCase`，上一项/下一项执行 `reader.search.next`/`reader.search.prev`，点击结果列表项执行 `reader.search.goTo`（经导航历史跳转），关闭执行 `reader.search.close`；展示命中计数、搜索进度与可点击的结果摘录列表。由 `searchStore` 的视图状态驱动。
- `TocSidebar.tsx`：目录侧栏，展示活动阅读视图的 `BookDocument.getTOC()` 分层目录；点击条目经 `reader.goToHref` 执行显式跳转（压入导航历史），由 Workspace Store 的 `tocVisible` 控制显隐。
- `MetadataEditorDialog.tsx`：元数据编辑器对话框。覆盖标题/作者/封面并一键恢复来源元数据；所有变更经 `library.updateMetadata` / `library.setCover` / `library.removeCover` / `library.restoreMetadata` 命令执行，封面预览经 `importRepository.readCover` 读取。
- `PurgeConfirmDialog.tsx`：永久删除二次确认对话框。用户需输入书名才可执行 `library.purge`，取消或关闭不改变任何数据；由 `shellUiStore.purgeMaterialId` 控制开关。
- `ExternalLinkDialog.tsx`：外部链接确认对话框。书内点击的外部链接先展示目标，确认后经 `reader.openExternalUrl` 交给系统浏览器（ADR-0010）；由 `shellUiStore.externalLinkUrl` 控制开关。
- `ReaderSettingsDialog.tsx`：阅读排版对话框。调整当前激活阅读视图所属材料的字体、字号、行距、页边距、主题与分页/滚动模式，并可将材料级覆盖恢复为全局默认；所有变更经 `reader.typography.apply` / `reader.typography.reset` 命令执行并由 Workspace Store 持久化；由 `shellUiStore.typographyEditorViewId` 控制开关。
- `StatusBar.tsx`：底部状态栏，展示 `shellUiStore.statusMessage`。

## 依赖其它文件夹（树）

```
components/
├── app/AppServicesContext.tsx   useAppServices() 取 commands 与 Repository
├── commands/                    COMMAND_IDS 用于执行命令
├── domain/reader/               viewHost 类型(测试用伪宿主)
├── domain/library/              materialFormat / libraryFilter 纯函数(书库格式推断与筛选)
└── workbench/
    ├── workspaceStore.ts        ActivityBar 读 primarySidebarVisible;EditorArea 读 editorGroups;ReadingView 读 sourceMode
    ├── readerRuntime.ts         ReadingView 读 documents
    ├── readerCommands.ts        ReadingView 调 mountViewDocument
    ├── markdownSessionStore.ts  MarkdownSourceEditor 读写共享会话缓冲区
    ├── searchStore.ts           SearchBar 读视图搜索状态
    ├── libraryStore.ts          PrimarySidebar 读 materials/trashedMaterials;ActivityBar 读 importing
    └── shellUiStore.ts          StatusBar 读 statusMessage;MarkdownDirtyCloseDialog 读脏关闭状态;MarkdownRecoveryDialog 读恢复队列
```

## 被谁依赖（树）

```
app/App.tsx  ──►  components/
                  ├── ActivityBar
                  ├── AnnotationSidebar
                  ├── TocSidebar
                  ├── PrimarySidebar
                  ├── EditorArea
                  │     └─ ► ReadingView
                  │            └─ ► MarkdownSourceEditor
                  ├── MetadataEditorDialog
                  ├── MarkdownDirtyCloseDialog
                  ├── MarkdownRecoveryDialog
                  ├── PurgeConfirmDialog
                  ├── ExternalLinkDialog
                  ├── ReaderSettingsDialog
                  └── StatusBar
```

## 依赖方向

`components/` 只消费状态与命令，不直接触碰持久化/Repository；用户意图一律经 Command 表达，由 `workbench/` 的命令实现处理。阅读视图的渲染器挂载是渲染职责，经 `mountViewDocument` 窄函数完成，不泄漏 Foliate View 到组件。
