# `src/workbench` — 工作台状态与命令实现

## 功能

- `workspaceStore.ts`：zustand Store，持有可序列化的工作区状态（`primarySidebarVisible`、`activeEditorGroupId`、`editorGroups`、`globalReadingTypography` 全局阅读默认、`materialTypography` 材料级排版覆盖）及 `openView`/`closeView`/`setActiveView`/`setViewLocation`/`pushViewLocation`/`setViewHistory`/`setGlobalReadingTypography`/`setMaterialTypography`/`resetMaterialTypography`/`getEffectiveTypography`/`hydrate`/`resetToDefault` 等动作；用 `navigationHistory` 维护每个视图的可序列化导航历史；渲染器、选区等活对象不进入本 Store。
- `readerRuntime.ts`：Reader Runtime（活对象 Store），按阅读视图 id 持有 `BookDocument`；不参与持久化。
- `searchStore.ts`：当前材料搜索的运行时状态（按阅读视图 id 组织）：搜索栏开关、查询、大小写、进度、命中列表、当前命中下标与 CFI；不可持久化。
- `searchRunner.ts`：搜索任务编排。每个视图最多一个运行中的搜索生成器；新查询/关闭/销毁视图会取消旧任务并清除高亮，避免异步任务写回错误视图。`runSearch`/`cancelSearch`/`clearSearch`/`cancelAllSearches` 供命令与关闭流程调用。
- `positionPersister.ts`：`ThrottledPositionPersister` 阅读位置节流写入器，高频 relocate 合并为周期写入，`dispose`/`flush` 强制写入最新位置。
- `readerCommands.ts`：阅读 Command 唯一实现入口。注册 `library.openBook`（读取托管 EPUB→构造 BookDocument→新增标签）、`reader.nextPage`/`reader.prevPage`（普通翻页，替换当前历史节点）、`reader.goToHref`（目录/书内链接显式跳转，压入历史）、`reader.back`/`reader.forward`（导航历史后退/前进）、`reader.openExternalUrl`（交给系统浏览器）、`reader.search.open`/`reader.search.close`/`reader.search.run`/`reader.search.toggleCase`/`reader.search.next`/`reader.search.prev`/`reader.search.goTo`（当前激活视图内搜索与命中跳转）、`reader.typography.apply`（把材料级排版覆盖写入 Store 并应用到 BookDocument）、`reader.typography.reset`（清除材料级覆盖回退全局默认）、`reader.typography.setGlobal`（更新全局默认并应用到无覆盖的开放视图）、`reader.closeView`（flush 位置、取消并清理搜索、关闭）、`reader.restoreView`（重启恢复时重建文档）。`reader.nextPage`/`reader.prevPage` 接受可选 viewId 参数，缺省回退到活动视图，便于按视图定向分发。`mountViewDocument` 供 ReadingView 挂载，并接线位置持久化、导航历史意图、书内/外部链接事件与打开时应用有效排版。
- `shellUiStore.ts`：外壳运行时反馈状态（`statusMessage`、`metadataEditorMaterialId`、`purgeMaterialId`、`externalLinkUrl`、`typographyEditorViewId`、`tocVisible`），不参与持久化。
- `libraryStore.ts`：书库可序列化状态（`materials`、`trashedMaterials`）与 `importing` 瞬时反馈。
- `workbenchCommands.ts`：工作台 Command 的唯一实现入口。`registerWorkbenchCommands` 注册 `workbench.togglePrimarySidebar` 与 `workbench.saveState`，先经 Repository 持久化成功后更新 Store。
- `importBook.ts`：批量导入编排 `importBooks`（一次多选、顺序 stage → inspect → commit、逐文件结果与失败分类），`classifyImportError` 把失败归类为 empty/unsupported/corrupt/permission/space/other。
- `libraryCommands.ts`：书库 Command 唯一实现入口（`library.import`、`library.refresh`、元数据覆盖 `library.updateMetadata`/`library.setCover`/`library.removeCover`/`library.restoreMetadata`，回收站 `library.trash`/`library.restoreFromTrash`/`library.purge`）。
- 对应 `*.test.ts`：Store、命令、位置持久化与阅读编排行为测试。

## 依赖其它文件夹（树）

```
workbench/
├── commands/            CommandRegistry 与 COMMAND_IDS
├── app/
│   ├── filePicker        FilePicker 窄接口
│   └── externalUrlOpener ExternalUrlOpener 窄接口(Tauri/浏览器打开外部链接)
└── domain/
    ├── workspace/       WorkspaceRepository、WorkspaceState
    ├── library/         ImportRepository、ReadingMaterial、EpubInspector
    └── reader/          BookDocument、EpubBookDocument、viewHost、sanitizer、navigationHistory、search
```

## 被谁依赖（树）

```
workbench/
├── app/
│   ├── bootstrap.ts     调用 registerWorkbenchCommands / registerLibraryCommands / registerReaderCommands
│   └── App.tsx          useWorkspaceStore / useShellUiStore 状态恢复与启动恢复阅读视图
└── components/          workspaceStore / shellUiStore / libraryStore / readerRuntime 供外壳组件读取;
                        ReadingView 调用 mountViewDocument 挂载
```

## 依赖方向

`workbench/` 构建在 `commands/` 与 `domain/` 之上，向下游（`app/`、`components/`）提供 Store 与命令实现；它不反向依赖 UI 组件。可序列化状态（标签、阅读位置）在 Workspace Store，活对象（BookDocument）在 Reader Runtime，两者严格分离。