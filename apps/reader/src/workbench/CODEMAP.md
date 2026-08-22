# `src/workbench` — 工作台状态与命令实现

## 功能

- `layoutPolicy.ts`：按 Workbench 实际容器宽度计算紧凑/中等/宽布局；紧凑布局只显示活动 Editor Group，并把侧栏降级为覆盖抽屉，不修改可序列化的工作区状态。对应 `layoutPolicy.test.ts`。

- 主要材料与侧栏：`workspaceStore.ts` 持久化 `primaryMaterialId`、`primarySidebarVisible`、`tocVisible` 与 `activityPanelWidth`；`shellUiStore.ts` 仅运行时持有批注覆盖面板 materialId、紧凑抽屉临时关闭状态和筛选聚焦 token；`workbenchCommands.ts` 提供侧栏/主要材料/宽度命令；`readerCommands.ts` 提供 `annotation.goTo`，集中处理批注跳转并拒绝失联批注的猜测定位。

- `workspaceStore.ts`：zustand Store，持有可序列化的工作区状态（`primarySidebarVisible`、`tocVisible`、`activityPanelWidth`、`splitDirection`、`activeEditorGroupId`、`editorGroups`、`globalReadingTypography` 全局阅读默认、`materialTypography` 材料级排版覆盖）及 `setActivityPanelWidth`、`focusEditorGroup`/`splitEditorGroup`/`openView`/`closeView`/`removeMaterial`/`setActiveView`/`setViewSourceMode`/`setViewLocation`/`pushViewLocation`/`setViewHistory`/`setGlobalReadingTypography`/`setMaterialTypography`/`resetMaterialTypography`/`getEffectiveTypography`/`hydrate`/`resetToDefault` 等动作；`openView` 只在当前组内按 BookId 复用已有标签，`splitEditorGroup` 最多创建第二组并复制当前活动视图；用 `navigationHistory` 维护每个视图的可序列化导航历史；渲染器、选区等活对象不进入本 Store。`ReadingView` 的 `sourceMode` 字段标记视图是否处于 Markdown 源码模式（可序列化）。
- `readerRuntime.ts`：Reader Runtime（活对象 Store），按阅读视图 id 持有 `BookDocument`；每个 Editor Group 仅保留活动视图，整个应用最多两个活动渲染器；不参与持久化。
- `searchStore.ts`：当前材料搜索的运行时状态（按阅读视图 id 组织）：搜索栏开关、查询、大小写、文本/正则模式、进度、命中列表、当前命中下标与 CFI；不可持久化。搜索错误会清空残留命中，避免失败查询污染后续状态。
- `searchRunner.ts`：搜索任务编排。每个视图最多一个运行中的搜索生成器；新查询/关闭/销毁视图会取消旧任务并清除高亮，正则模式额外传递取消信号，预算错误也会清除部分绘制结果，避免异步任务写回错误视图。`runSearch`/`cancelSearch`/`clearSearch`/`cancelAllSearches` 供命令与关闭流程调用。
- 搜索模式由 `reader.search.toggleMode` 在 Command Registry 中切换；`readerCommands.ts` 把文本/正则模式和大小写统一传给 `BookDocument`，失败状态由 `searchStore.ts` 清空残留命中。
- `positionPersister.ts`：`ThrottledPositionPersister` 阅读位置节流写入器，高频 relocate 合并为周期写入，`dispose`/`flush` 强制写入最新位置。
- `readerCommands.ts`：阅读 Command 唯一实现入口。注册 `workbench.splitEditorGroupRight`/`workbench.splitEditorGroupDown`（最多创建第二组并为复制视图建立第二个 Runtime）、`library.openBook`（在当前组按 BookId 激活既有标签或读取托管材料→构造 BookDocument→新增标签；Markdown 通过 `ManagedFileSource` 分块物化文本，EPUB/PDF 保留各自字节缓冲路径；EPUB 可尝试 `EpubNativeAccelerator`，协议/预取/桥接失败时透明回到同一纯 JS 语义路径）、`reader.activateView`（切换当前组活动标签，释放同组旧标签 Runtime 并按保存的位置重建新标签 Runtime）、`reader.nextPage`/`reader.prevPage`（普通翻页，替换当前历史节点）、`reader.goToHref`（目录/书内链接显式跳转，压入历史）、`reader.back`/`reader.forward`（导航历史后退/前进）、`reader.openExternalUrl`（交给系统浏览器）、`reader.search.open`/`reader.search.close`/`reader.search.run`/`reader.search.toggleCase`/`reader.search.next`/`reader.search.prev`/`reader.search.goTo`（当前激活视图内搜索与命中跳转）、`reader.typography.apply`（把材料级排版覆盖写入 Store 并应用到同材料开放视图）、`reader.typography.reset`（清除材料级覆盖回退全局默认）、`reader.typography.setGlobal`（更新全局默认并应用到无覆盖的开放视图）、`reader.closeView`（flush 位置、取消并清理搜索、关闭；Markdown 脏文档先弹确认）、`reader.restoreView`（重启恢复时按组重建活动标签文档）。`createMarkdownDocument` 打开 Markdown 视图时建立/复用该材料的共享 `MarkdownDocumentSession`。`reader.nextPage`/`reader.prevPage` 接受可选 viewId 参数，缺省回退到活动视图，便于按视图定向分发。`mountViewDocument` 供 ReadingView 挂载，并接线位置持久化、导航历史意图、书内/外部链接事件与打开时应用有效排版。
- `markdownSource.ts`：工作台与 ImportRepository 的 Markdown Source 接线；只负责按材料打开 Source，完整文本物化委托 `domain/reader/markdown/markdownSource.ts`。
- `markdownSessionStore.ts`：Markdown 文档会话 Store（ADR-0009）。同一 BookId 只有一个会话，跨组 ReadingView 共享未保存缓冲区；持有源文本、脏标记与已保存文档版本；永久清理时通过 `removeSession` 丢弃运行时缓冲区。`recordFormalSave` 只在缓冲区仍等于本次保存文本时清除脏标记，保存期间若继续输入则升级基础版本但保留为脏；`restoreRecovery` 把用户确认的快照载入为脏缓冲区。正式内容与快照都不存入本 Store。
- `markdownCommands.ts`：Markdown 源码编辑 Command 唯一实现入口。除源码模式、正式保存、放弃与脏关闭流程外，注册 `markdown.updateBuffer`（1 秒节制写 Recovery Snapshot，同一材料的异步写严格串行）、`markdown.recovery.check` / `resolve` / `flush`（启动检查、恢复或丢弃、终止前 flush）。正式保存先稳定当前写入，再原子保存正式材料；保存后重建、放弃和重新打开正式内容均通过 `ManagedFileSource` 读取，完整文本物化委托 Markdown 领域模块；只有缓冲区未在保存期间变化才清理快照，否则保留脏会话并立即按新基础版本补写快照。清理失败保留为下次启动的安全冲突。增量 Markdown 解析不在工单 #34 范围内。
- `annotationStore.ts` / `annotationCommands.ts`：按材料维护批注运行时集合，编排文本/扫描 PDF 区域高亮创建、笔记编辑、删除、加载与版本变化后的文本锚点恢复；恢复仅接受唯一引文与前后文匹配，失联批注保留但不绘制；永久清理通过 `removeMaterialAnnotations` 丢弃运行时缓存。
- `annotationExportCommands.ts`：批注 Markdown 导出 Command 唯一入口；按材料读取批注、调用系统目标选择器与 typed 写入器，取消/失败均通过状态栏反馈且不改写阅读状态。
- `shellUiStore.ts`：外壳运行时反馈状态（状态栏、各类对话框、`markdownRecoverySnapshots` 启动处理队列、版本迁移候选/预览/恢复快照、材料批注覆盖面板与紧凑抽屉状态），不参与持久化。
- `libraryStore.ts`：书库可序列化状态（`materials`、`trashedMaterials`）与 `importing` 瞬时反馈。
- `workbenchCommands.ts`：工作台 Command 的唯一实现入口。`registerWorkbenchCommands` 注册书库/目录侧栏切换、筛选聚焦、主要材料设置、材料批注覆盖面板、笔记编辑入口、阅读排版入口、`app.back`、`shell.dismissDialog`、`workbench.focusEditorGroup` 与 `workbench.saveState`；可序列化状态只在 Workspace Store 中持久化，覆盖面板等瞬时 UI 不落库。
- `importBook.ts`：批量导入编排 `importBooks`（一次多选、顺序 stage → inspect → commit、逐文件结果与失败分类），`classifyImportError` 把失败归类为 empty/unsupported/corrupt/permission/space/other。
- `libraryCommands.ts`：书库 Command 唯一实现入口（`library.import`、`library.refresh`、`library.relink`、显式版本迁移预览/确认/取消与恢复快照、元数据覆盖 `library.updateMetadata`/`library.setCover`/`library.removeCover`/`library.restoreMetadata`，回收站 `library.trash`/`library.restoreFromTrash`/`library.purge`）；重新导入或重新关联同指纹文件后可刷新当前缺失正文视图，永久清理同步清除打开视图、工作区材料状态、运行时批注/Markdown 会话并保存工作区。
- `backupCommands.ts`：完整书库备份 Command 唯一入口（`library.exportBackup`）；先提示未加密备份风险，再打开目标选择器并 flush 当前阅读位置，只有 Rust 导出成功后才报告完成，取消或失败均不调用成功状态。
- `viewUtils.ts`：工作区视图查找共享工具（`findView`/`getActiveViewId`/`findViewGroupId`/`findViewInGroupByMaterialId`/`isViewActive`/`findViewMaterialId`），供各命令模块复用。
- 对应 `*.test.ts`：Store、命令、位置持久化与阅读编排行为测试。

## 依赖其它文件夹（树）

```
Workspace State also includes `tocVisible`; sidebar preference state belongs to `workspaceStore.ts`, while `shellUiStore.ts` contains runtime-only UI state.
workbench/
├── commands/            CommandRegistry 与 COMMAND_IDS
├── app/
│   ├── filePicker        FilePicker 窄接口
│   └── externalUrlOpener ExternalUrlOpener 窄接口(Tauri/浏览器打开外部链接)
└── domain/
    ├── workspace/       WorkspaceRepository、WorkspaceState
    ├── library/         ImportRepository、BackupRepository、ReadingMaterial、EpubInspector
    ├── annotation/      AnnotationRepository、TextAnchor
    └── reader/          BookDocument、EpubBookDocument、viewHost、sanitizer、navigationHistory、search
```

## 被谁依赖（树）

```
workbench/
├── app/
│   ├── bootstrap.ts     调用 registerWorkbenchCommands / registerLibraryCommands / registerReaderCommands / registerMarkdownCommands
│   └── App.tsx          useWorkspaceStore / useShellUiStore 状态恢复与启动恢复阅读视图
└── components/          workspaceStore / shellUiStore / libraryStore / readerRuntime / markdownSessionStore 供外壳组件读取;
                        ReadingView 调用 mountViewDocument 挂载;MarkdownSourceEditor 读写共享会话
```

## 依赖方向

`workbench/` 构建在 `commands/` 与 `domain/` 之上，向下游（`app/`、`components/`）提供 Store 与命令实现；它不反向依赖 UI 组件。可序列化状态（标签、阅读位置）在 Workspace Store，活对象（BookDocument）在 Reader Runtime，两者严格分离；批注导出只读取材料级 AnnotationRepository 并经 AnnotationExportWriter 调用 Rust，不读取本地文件或数据库。
## 完整书库备份恢复

`backupCommands.ts` 通过 `BackupSourcePicker` 选择 `.airbackup`，先 flush 阅读位置，再调用 `BackupRepository.restoreBackup`；Rust 完成整库校验和可恢复切换后，桌面端重载应用以加载新的工作区、位置和批注。
