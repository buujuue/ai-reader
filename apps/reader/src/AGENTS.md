# apps/reader/src — React + TypeScript 前端

阅读器前端。入口 `main.tsx`，全局样式 `index.css`。

## 目录内容

| 目录/文件 | 内容 |
| --- | --- |
| `Workspace State ownership` | `workspaceStore.ts` is the serializable source of tabs, editor groups, active views, and sidebar preferences; `shellUiStore.ts` contains runtime-only UI state. |
| `app/` | `App.tsx` 应用外壳（启动恢复工作区与 Markdown 快照、重启恢复阅读视图、桌面关闭请求等待 flush、页面隐藏时尽力 flush、Android 系统返回键按次级状态逐层退出）；`WorkbenchPrototype.tsx` / `workbenchPrototype.css` 为仅在开发态通过 `?prototype=workbench&variant=A|B|C` 打开的抛弃式工作台视觉原型，不接入真实 Repository；`bootstrap.ts` 组装 `AppServices`（CommandRegistry + WorkspaceRepository + ImportRepository + AnnotationRepository + AnnotationExportDestinationPicker + AnnotationExportWriter + BackupRepository + ExternalUrlOpener + FilePicker + BackupDestinationPicker + BackupSourcePicker + WindowLifecycle + AndroidBackButton + EpubNativeAccelerator），按是否在 Tauri 运行时选择真实或内存/不支持 Adapter；`externalUrlOpener.ts` 外部链接打开窄接口（Tauri opener 插件 / 浏览器降级）；`filePicker.ts` 系统文件选择器窄接口（Android 使用文档选择器和托管复制）；`androidBackButton.ts` Android 返回行为解析；`platform.ts` Android WebView 判断；`backupDestinationPicker.ts` 备份目标选择器窄接口；`annotationExportDestinationPicker.ts` 单本批注 Markdown 保存位置选择器窄接口；`backupSourcePicker.ts` 完整备份来源选择器窄接口；`AppServicesContext.tsx` 服务上下文；`App.test.tsx` 应用级测试。 |
| `commands/` | `commandRegistry.ts`：Command Registry 与稳定 Command ID 注册机制。 |
| `components/` | 工作台外壳组件：`ApplicationBar.tsx`（真实文件/编辑/查看菜单）、`ActivityBar.tsx`（仅书库与目录入口）、`TocSidebar.tsx`（分层目录点击跳转）、`PrimarySidebar.tsx`（持久化文件夹树、未归类区域、单本材料移动菜单、标题/作者筛选，点击打开 + 编辑元数据入口）、`MaterialCover.tsx`（封面懒加载渲染与占位）、`EditorArea.tsx`（最多两个 Editor Group、独立阅读标签栏与活动 ReadingView、向右/向下拆分、Markdown 源码模式切换按钮）、`ReadingView.tsx`（挂载 BookDocument 到容器并注册输入接线清理；Runtime 的 flush/挂起/关闭由命令层负责 + 材料级更多菜单 + 源码模式切换到 MarkdownSourceEditor，并把输入定向到所属组）、`AnnotationSidebar.tsx`（导出的 `AnnotationPanel`，材料级运行时批注覆盖面板）、`VersionMigrationDialog.tsx`（EPUB 版本迁移预览/确认与恢复快照）、其余为搜索、批注、元数据、备份与状态对话框。 |
| `domain/` | 领域层：`workspace/` 工作区（Editor Group、阅读视图、阅读位置、导航历史）、`library/` 书库与导入/文件夹归属/完整备份/显式 EPUB 版本迁移（含 Markdown Recovery Snapshot 与迁移恢复快照 typed Repository、`BackupRepository`、`ManagedFileSource`、内建最小 `EpubInspector`、格式推断与筛选）、`annotation/` 批注（`Annotation`/`TextAnchor` 类型、单 spine 选区校验、已重锚/失联恢复、Markdown 导出 formatter、内存/localStorage/Tauri Adapter）、`reader/` 阅读文档（`BookDocument`、EPUB/PDF/Markdown 文档、位置/导航、Foliate 宿主、清洗器与格式子模块）、`tauriInvoke.ts` 共享 invoke 类型。 |
| `workbench/` | `workspaceStore.ts`（可序列化工作区状态 + 导航历史动作）、`readerRuntime.ts`（活 BookDocument）、`readerRuntimeCache.ts`（EPUB/Markdown 有界 Runtime 缓存与 LRU 预算）、`markdownSessionStore.ts`（共享 Markdown 缓冲区）、`markdownCommands.ts`（源码编辑、正式保存与 Recovery Snapshot 编排）、`backupCommands.ts`（备份确认、来源/目标选择、flush、恢复与导出编排）、`annotationExportCommands.ts`（单本批注 Markdown 导出编排）、`searchStore.ts` / `searchRunner.ts`（当前材料搜索）、`positionPersister.ts`（阅读位置节流/flush）、`readerCommands.ts`（阅读命令）、`workbenchCommands.ts`（工作台命令）、`libraryStore.ts` / `libraryCommands.ts` / `importBook.ts`（书库、导入与版本迁移）、`annotationStore.ts` / `annotationCommands.ts`（批注创建、批量锚点恢复与软删除恢复）、`shellUiStore.ts`（外壳 UI 状态），及对应测试。 |

| `test/setup.ts` | Vitest 测试环境配置。 |

## 约定

- Markdown Runtime 约定：源码模式由 CodeMirror 独占可见编辑区并挂起 Foliate；共享会话缓冲区、正式保存和 Recovery Snapshot 变化先失效相关缓存，再由 `readerCommands.ts` 按当前会话文本恢复非源码视图。

- `AnnotationSidebar.tsx` 导出 `AnnotationPanel`，按 materialId 读取批注并作为运行时覆盖面板显示；主要材料设置、批注跳转与导出分别经稳定 Command 执行，面板开关和焦点恢复留在 `shellUiStore`，不写入 Workspace State。

- 涉及页面、组件、布局、色彩、排版、图标、交互状态、响应式、动效或无障碍的设计、实现与评审，先读取根 `style.md`。共识版 C 原型只提供视觉方向；生产界面必须同时服从正式产品范围、容器布局策略和 Command/Repository 边界。
- 用户意图一律走 Command：UI 组件执行 Command，不在组件里另接行为逻辑；命令必须在 `commands/` 注册稳定 ID。
- 前端不接触 SQLite 表、SQL、数据库路径与文件细节；平台能力只经 typed Repository 接口调用 Rust 命令。`ManagedFileSource` 只接收稳定 MaterialId 解析出的 File/Blob 兼容范围来源，不向格式层暴露 Tauri 协议或路径。
- 内存 Adapter 与 Tauri Adapter 必须运行同一份 `workspaceRepository.contract.ts` 契约测试；Repository 接口变化时同步更新契约与两个 Adapter。
- Workspace State 必须可序列化；Reader Runtime 活对象（视图、选区、加载任务）不得进入持久化状态。每个 Editor Group 仅保留活动阅读器，全应用最多两个活动渲染器；EPUB/Markdown 完成打开后可由 `readerRuntimeCache.ts` 按有界预算挂起，切换由 `readerCommands.ts` 先 flush 并清除输入/搜索接线，PDF 保持关闭重建；材料失效与整库恢复必须释放旧对象。
- Markdown 源码模式下 CodeMirror 与 Foliate Runtime 不同时占有可见阅读区域；会话文本变化、正式保存或恢复快照载入必须使旧 Markdown Runtime 失效，阅读模式恢复时只能从当前共享会话或当前正式版本重建。

## Readest 参照

实现任何前端模块（工作台布局、命令系统、存储适配、阅读视图等）前，先看 Readest 对应实现；有能直接复制的代码直接复制移植，并在 `docs/legal/third-party.md` 登记来源与许可。详见根 `AGENTS.md`。
