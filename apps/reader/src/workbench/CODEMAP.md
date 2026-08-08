# `src/workbench` — 工作台状态与命令实现

## 功能

- `workspaceStore.ts`：zustand Store，持有可序列化的工作区状态（`primarySidebarVisible`、`activeEditorGroupId`、`editorGroups`）及 `openView`/`closeView`/`setActiveView`/`setViewLocation`/`hydrate`/`resetToDefault` 等动作；渲染器、选区等活对象不进入本 Store。
- `readerRuntime.ts`：Reader Runtime（活对象 Store），按阅读视图 id 持有 `BookDocument`；不参与持久化。
- `positionPersister.ts`：`ThrottledPositionPersister` 阅读位置节流写入器，高频 relocate 合并为周期写入，`dispose`/`flush` 强制写入最新位置。
- `readerCommands.ts`：阅读 Command 唯一实现入口。注册 `library.openBook`（读取托管 EPUB→构造 BookDocument→新增标签）、`reader.nextPage`/`reader.prevPage`（作用于活动视图）、`reader.closeView`（flush 位置并关闭）、`reader.restoreView`（重启恢复时重建文档）。`mountViewDocument` 供 ReadingView 组件在自身容器内挂载。
- `shellUiStore.ts`：外壳运行时反馈状态（`statusMessage`、`metadataEditorMaterialId`、`purgeMaterialId`），不参与持久化。
- `libraryStore.ts`：书库可序列化状态（`materials`、`trashedMaterials`）与 `importing` 瞬时反馈。
- `workbenchCommands.ts`：工作台 Command 的唯一实现入口。`registerWorkbenchCommands` 注册 `workbench.togglePrimarySidebar` 与 `workbench.saveState`，先经 Repository 持久化成功后更新 Store。
- `importBook.ts`：批量导入编排 `importBooks`（一次多选、顺序 stage → inspect → commit、逐文件结果与失败分类），`classifyImportError` 把失败归类为 empty/unsupported/corrupt/permission/space/other。
- `libraryCommands.ts`：书库 Command 唯一实现入口（`library.import`、`library.refresh`、元数据覆盖 `library.updateMetadata`/`library.setCover`/`library.removeCover`/`library.restoreMetadata`，回收站 `library.trash`/`library.restoreFromTrash`/`library.purge`）。
- 对应 `*.test.ts`：Store、命令、位置持久化与阅读编排行为测试。

## 依赖其它文件夹（树）

```
workbench/
├── commands/            CommandRegistry 与 COMMAND_IDS
├── app/filePicker       FilePicker 窄接口
└── domain/
    ├── workspace/       WorkspaceRepository、WorkspaceState
    ├── library/         ImportRepository、ReadingMaterial、EpubInspector
    └── reader/          BookDocument、EpubBookDocument、viewHost、sanitizer
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