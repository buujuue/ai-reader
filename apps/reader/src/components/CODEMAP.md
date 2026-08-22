# `src/components` — 工作台外壳组件

## 功能

- `ApplicationBar.tsx`：生产默认入口的 C 风格应用顶栏，仅提供真实文件/编辑/查看动作并通过 Command 执行。
- `AnnotationSidebar.tsx`：导出 `AnnotationPanel`，按 materialId 显示材料级运行时批注覆盖面板，支持引文/笔记筛选、正常/已重锚/失联标识，以及通过 `annotation.goTo` 跳转正文或 PDF 区域；查看、编辑、关闭和导出均通过 Command/运行时外壳边界完成，面板不进入 Workspace State。

- `SelectionToolbar.tsx`：监听正文文本选区与 PDF 扫描页区域选区；EPUB 选区提交前校验是否处于单一 spine section，跨章节显示阻止原因；按选区类型显示高亮动作，经 `annotation.createHighlight` 或 `annotation.createPdfArea` Command 创建批注，不把选区活对象写入工作区状态。

- `ActivityBar.tsx`：左侧活动栏只提供“书库”与“目录”两个互斥入口，分别执行 `workbench.togglePrimarySidebar` 与 `workbench.toggleToc`；导入动作位于真实书库面板与文件菜单。
- `SidebarPanelHeader.tsx`：书库与目录共用的固定顶栏结构，统一标题、图标、右侧操作槽、行高和触控命中区，不承载具体业务行为。
- `SidebarResizeHandle.tsx`：书库与目录共用的可拖动/可键盘调整宽度手柄；拖动过程更新活动面板宽度，结束时经 `workbench.setActivityPanelWidth` 持久化，不直接访问 Repository。
- `PrimarySidebar.tsx`：书库侧栏，紧凑封面网格展示 `libraryStore.materials`，顶部搜索框按标题/作者即时筛选；点击或键盘激活封面卡片执行 `library.openBook` 打开阅读标签；托管副本缺失的材料仍显示并明确标记“正文不可用”，可通过「重新关联正文」（`library.relink`）选择同内容文件恢复；鼠标悬浮或键盘聚焦书卡后，书库标题栏右上角的「更多操作」菜单承载元数据编辑、主要材料、重新关联与移入回收站命令；底部回收站区块展示 `libraryStore.trashedMaterials`，可「恢复」（`library.restoreFromTrash`）与「永久删除」（`shellUiStore.openPurgeConfirm` 打开确认对话框）；含书库空、筛选无结果两类空态。
- `MaterialCover.tsx`：封面渲染，经 `importRepository.readCover` 读取托管封面字节并以对象 URL 渲染；默认 IntersectionObserver 懒加载（进入视口才解码）、卸载时 revoke 释放；无封面复用工作区底色和文字颜色显示书名占位，加载失败显示「封面加载失败」。
- `EditorArea.tsx`：编辑器区，按持久化拆分方向渲染最多两个 Editor Group；每组直接承载活动 `ReadingView`，不再渲染标签栏。点击编辑器组和紧凑布局组切换按钮通过 Command 维护当前组与 Runtime；无活动视图时显示空状态占位。
- `ReadingView.tsx`：单个阅读视图正文。把所属组活动视图的 `BookDocument` 通过 `mountViewDocument` 挂载到自身容器；托管副本缺失时由 Reader Runtime 显示明确的“正文当前不可用”错误并保留标签/用户数据；阅读工具栏提供阅读排版与 Markdown 源码模式，存在拆分组时在材料更多操作左侧提供关闭当前拆分区的 X；材料更多菜单提供向右/向下拆分、查看/导出批注与设置主要材料；导航历史仍由目录、搜索和 Reader Command 维护，不在常驻工具栏显示前进/后退按钮。Markdown 视图处于源码模式时渲染 `MarkdownSourceEditor` 而非阅读容器。Reader 外部不直接操作 Foliate View。
- `MarkdownSourceEditor.tsx`：Markdown 源码模式编辑器（ADR-0009）。仅在首次进入源码模式时动态加载 CodeMirror 6（高亮、撤销重做、查找替换），读写共享 `MarkdownDocumentSession` 缓冲区，并把用户确认恢复的外部会话文本同步到已挂载编辑器；程序化同步不会回流为用户编辑 Command，避免放弃后重新制造快照。绑定 Ctrl/Cmd+S 执行 `markdown.save`，由 `ReadingView` 在 `sourceMode` 时渲染。
- `MarkdownDirtyCloseDialog.tsx`：脏 Markdown 文档关闭/退出源码模式确认对话框。提供「保存」「放弃」「取消」，分别执行 `markdown.closeDirty` 的 save/discard/cancel；由 `shellUiStore.markdownDirtyCloseViewId` 控制开关。
- `MarkdownRecoveryDialog.tsx`：启动恢复对话框。逐份展示 available/conflict/corrupt 快照；有效或冲突快照可经 `markdown.recovery.resolve` 载入为未保存缓冲区，损坏快照只允许丢弃，绝不自动覆盖正式内容。
- `VersionMigrationDialog.tsx`：EPUB 新版本显式迁移对话框，先选择候选再展示进度/批注的保持、唯一重锚和孤儿预览；确认后提交并提供持续保留的迁移前恢复快照列表。
- `SearchBar.tsx`：当前阅读视图的搜索栏（顶部覆盖层）。输入经防抖后执行 `reader.search.run`，大小写开关执行 `reader.search.toggleCase`，上一项/下一项执行 `reader.search.next`/`reader.search.prev`，点击结果列表项执行 `reader.search.goTo`（经导航历史跳转），关闭执行 `reader.search.close`；展示命中计数、搜索进度与可点击的结果摘录列表。由 `searchStore` 的视图状态驱动。
- `SearchBar.tsx` 还通过 `reader.search.toggleMode` 切换文本/正则模式，并对预算、语法或取消错误显示可访问的 `role="alert"` 状态。
- `TocSidebar.tsx`：目录侧栏，展示活动阅读视图的 `BookDocument.getTOC()` 分层目录；点击条目经 `reader.goToHref` 执行显式跳转（压入导航历史），并在 `getTOCSource()` 或条目标记表明为派生目录时提示“正文推导”及非权威说明；由 Workspace Store 的 `tocVisible` 控制显隐。
- `MetadataEditorDialog.tsx`：元数据编辑器对话框。覆盖标题/作者/封面并一键恢复来源元数据；所有变更经 `library.updateMetadata` / `library.setCover` / `library.removeCover` / `library.restoreMetadata` 命令执行，封面预览经 `importRepository.readCover` 读取。
- `PurgeConfirmDialog.tsx`：永久删除二次确认对话框。用户需输入书名才可执行 `library.purge`，取消或关闭不改变任何数据；由 `shellUiStore.purgeMaterialId` 控制开关。
- `ExternalLinkDialog.tsx`：外部链接确认对话框。书内点击的外部链接先展示目标，确认后经 `reader.openExternalUrl` 交给系统浏览器（ADR-0010）；由 `shellUiStore.externalLinkUrl` 控制开关。
- `ReaderSettingsDialog.tsx`：阅读排版对话框。调整当前激活阅读视图所属材料的字体、字号、行距、页边距、主题与分页/滚动模式，并可将材料级覆盖恢复为全局默认；所有变更经 `reader.typography.apply` / `reader.typography.reset` 命令执行并由 Workspace Store 持久化；由 `shellUiStore.typographyEditorViewId` 控制开关。
- `StatusBar.tsx`：底部状态栏，展示当前激活材料的 `AI Reader · 书名` 身份文案与 `shellUiStore.statusMessage`；批注软删除成功后提供一次性“撤销删除”入口，经 `annotation.restore` Command 恢复。

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
    ├── libraryStore.ts          PrimarySidebar 读 materials/trashedMaterials;StatusBar 读当前材料元数据;ActivityBar 读 importing
    ├── shellUiStore.ts          ApplicationBar/AnnotationPanel 读运行时面板状态;StatusBar 读 statusMessage;MarkdownDirtyCloseDialog 读脏关闭状态;MarkdownRecoveryDialog 读恢复队列
    └── workspaceStore.ts        StatusBar 读当前激活 Editor Group/ReadingView;ReadingView 读拆分与活动组
```

## 被谁依赖（树）

```
app/App.tsx  ──►  components/
                  ├── ApplicationBar
                  ├── ActivityBar
                  ├── AnnotationPanel (由 AnnotationSidebar.tsx 导出)
                  ├── TocSidebar
                  ├── PrimarySidebar
                  ├── SidebarResizeHandle
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
