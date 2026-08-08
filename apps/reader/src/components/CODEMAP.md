# `src/components` — 工作台外壳组件

## 功能

- `ActivityBar.tsx`：左侧活动栏，提供“导入 EPUB”按钮（执行 `library.importOne`）、“切换主侧栏”按钮（执行 `workbench.togglePrimarySidebar`）与“切换目录”按钮（切换 `shellUiStore.tocVisible`）。
- `PrimarySidebar.tsx`：书库侧栏，紧凑封面网格展示 `libraryStore.materials`，顶部搜索框按标题/作者即时筛选；点击或键盘激活封面卡片执行 `library.openBook` 打开阅读标签；卡片右上角「编辑」执行 `shellUiStore.openMetadataEditor` 打开元数据编辑器、「移入回收站」执行 `library.trash`；底部回收站区块展示 `libraryStore.trashedMaterials`，可「恢复」（`library.restoreFromTrash`）与「永久删除」（`shellUiStore.openPurgeConfirm` 打开确认对话框）；含书库空、筛选无结果两类空态。
- `MaterialCover.tsx`：封面渲染，经 `importRepository.readCover` 读取托管封面字节并以对象 URL 渲染；默认 IntersectionObserver 懒加载（进入视口才解码）、卸载时 revoke 释放；无封面「暂无封面」与加载失败「封面加载失败」两种占位。
- `EditorArea.tsx`：编辑器区，渲染阅读标签栏（tablist）与活动 `ReadingView`；无标签时显示空状态占位；关闭按钮执行 `reader.closeView`。
- `ReadingView.tsx`：单个阅读视图正文。把活动视图的 `BookDocument` 通过 `mountViewDocument` 挂载到自身容器，卸载时 flush 位置并释放渲染器；Reader 外部不直接操作 Foliate View。
- `SearchBar.tsx`：当前阅读视图的搜索栏（顶部覆盖层）。输入经防抖后执行 `reader.search.run`，大小写开关执行 `reader.search.toggleCase`，上一项/下一项执行 `reader.search.next`/`reader.search.prev`，点击结果列表项执行 `reader.search.goTo`（经导航历史跳转），关闭执行 `reader.search.close`；展示命中计数、搜索进度与可点击的结果摘录列表。由 `searchStore` 的视图状态驱动。
- `TocSidebar.tsx`：目录侧栏，展示活动阅读视图的 `BookDocument.getTOC()` 分层目录；点击条目经 `reader.goToHref` 执行显式跳转（压入导航历史），由 `shellUiStore.tocVisible` 控制显隐。
- `MetadataEditorDialog.tsx`：元数据编辑器对话框。覆盖标题/作者/封面并一键恢复来源元数据；所有变更经 `library.updateMetadata` / `library.setCover` / `library.removeCover` / `library.restoreMetadata` 命令执行，封面预览经 `importRepository.readCover` 读取。
- `PurgeConfirmDialog.tsx`：永久删除二次确认对话框。用户需输入书名才可执行 `library.purge`，取消或关闭不改变任何数据；由 `shellUiStore.purgeMaterialId` 控制开关。
- `ExternalLinkDialog.tsx`：外部链接确认对话框。书内点击的外部链接先展示目标，确认后经 `reader.openExternalUrl` 交给系统浏览器（ADR-0010）；由 `shellUiStore.externalLinkUrl` 控制开关。
- `StatusBar.tsx`：底部状态栏，展示 `shellUiStore.statusMessage`。

## 依赖其它文件夹（树）

```
components/
├── app/AppServicesContext.tsx   useAppServices() 取 commands 与 Repository
├── commands/                    COMMAND_IDS 用于执行命令
├── domain/reader/               viewHost 类型(测试用伪宿主)
├── domain/library/              materialFormat / libraryFilter 纯函数(书库格式推断与筛选)
└── workbench/
    ├── workspaceStore.ts        ActivityBar 读 primarySidebarVisible;EditorArea 读 editorGroups
    ├── readerRuntime.ts         ReadingView 读 documents
    ├── readerCommands.ts        ReadingView 调 mountViewDocument
    ├── searchStore.ts           SearchBar 读视图搜索状态
    ├── libraryStore.ts          PrimarySidebar 读 materials/trashedMaterials;ActivityBar 读 importing
    └── shellUiStore.ts          StatusBar 读 statusMessage;PrimarySidebar 开元数据编辑器/回收站确认
```

## 被谁依赖（树）

```
app/App.tsx  ──►  components/
                  ├── ActivityBar
                  ├── TocSidebar
                  ├── PrimarySidebar
                  ├── EditorArea
                  │     └─ ► ReadingView
                  ├── MetadataEditorDialog
                  ├── PurgeConfirmDialog
                  ├── ExternalLinkDialog
                  └── StatusBar
```

## 依赖方向

`components/` 只消费状态与命令，不直接触碰持久化/Repository；用户意图一律经 Command 表达，由 `workbench/` 的命令实现处理。阅读视图的渲染器挂载是渲染职责，经 `mountViewDocument` 窄函数完成，不泄漏 Foliate View 到组件。