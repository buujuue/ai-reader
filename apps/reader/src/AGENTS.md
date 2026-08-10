# apps/reader/src — React + TypeScript 前端

阅读器前端。入口 `main.tsx`，全局样式 `index.css`。

## 目录内容

| 目录/文件 | 内容 |
| --- | --- |
| `app/` | `App.tsx` 应用外壳（启动恢复工作区与 Markdown 快照、重启恢复阅读视图、桌面关闭请求等待 flush、页面隐藏时尽力 flush）；`bootstrap.ts` 组装 `AppServices`（CommandRegistry + WorkspaceRepository + ImportRepository + AnnotationRepository + AnnotationExportDestinationPicker + AnnotationExportWriter + BackupRepository + ExternalUrlOpener + FilePicker + BackupDestinationPicker + BackupSourcePicker + WindowLifecycle），按是否在 Tauri 运行时选择真实或内存/不支持 Adapter；`externalUrlOpener.ts` 外部链接打开窄接口（Tauri opener 插件 / 浏览器降级）；`filePicker.ts` 系统文件选择器窄接口；`backupDestinationPicker.ts` 备份目标选择器窄接口；`annotationExportDestinationPicker.ts` 单本批注 Markdown 保存位置选择器窄接口；`backupSourcePicker.ts` 完整备份来源选择器窄接口；`AppServicesContext.tsx` 服务上下文；`App.test.tsx` 应用级测试。 |
| `commands/` | `commandRegistry.ts`：Command Registry 与稳定 Command ID 注册机制。 |
| `components/` | 工作台外壳组件：`ActivityBar.tsx`（导入 EPUB + 切换主侧栏 + 切换目录）、`TocSidebar.tsx`（分层目录点击跳转）、`PrimarySidebar.tsx`（书库紧凑封面网格 + 标题/作者筛选，点击打开 + 编辑元数据入口）、`MaterialCover.tsx`（封面懒加载渲染与占位）、`EditorArea.tsx`（最多两个 Editor Group、独立阅读标签栏与活动 ReadingView、向右/向下拆分、Markdown 源码模式切换按钮）、`ReadingView.tsx`（挂载 BookDocument 到容器，卸载 flush + 接线高亮点击打开笔记编辑器 + 源码模式切换到 MarkdownSourceEditor，并把输入定向到所属组）、`MarkdownSourceEditor.tsx`（CodeMirror 6 懒加载的 Markdown 源码编辑器，读写共享 MarkdownDocumentSession，绑定 Ctrl+S 保存）、`MarkdownDirtyCloseDialog.tsx`（脏 Markdown 关闭/退出源码模式的保存·放弃·取消确认）、`MarkdownRecoveryDialog.tsx`（启动时恢复、冲突或丢弃未保存快照）、`SearchBar.tsx`（当前阅读视图内搜索栏：防抖搜索、大小写开关、上一项/下一项与点击结果跳转、关闭清理）、`SelectionToolbar.tsx`（正文文本选区或 PDF 扫描页区域选区后的高亮工具栏）、`NoteEditorDialog.tsx`（为已有高亮添加/编辑/删除文字笔记）、`MetadataEditorDialog.tsx`（覆盖标题/作者/封面并恢复来源元数据）、`ExternalLinkDialog.tsx`（外部链接目标确认后交系统浏览器）、`PurgeConfirmDialog.tsx`（永久删除二次确认）、`StatusBar.tsx`。 |
| `domain/` | 领域层：`workspace/` 工作区（Editor Group、阅读视图、阅读位置、导航历史）、`library/` 书库与导入/完整备份（含 Markdown Recovery Snapshot typed Repository、`BackupRepository`、内建最小 `EpubInspector`、格式推断与筛选）、`annotation/` 批注（`Annotation`/`TextAnchor` 类型、锚点构建与恢复、Markdown 导出 formatter、内存/localStorage/Tauri Adapter）、`reader/` 阅读文档（`BookDocument`、EPUB/PDF/Markdown 文档、位置/导航、Foliate 宿主、清洗器与格式子模块）、`tauriInvoke.ts` 共享 invoke 类型。 |
| `workbench/` | `workspaceStore.ts`（可序列化工作区状态 + 导航历史动作）、`readerRuntime.ts`（活 BookDocument）、`markdownSessionStore.ts`（共享 Markdown 缓冲区）、`markdownCommands.ts`（源码编辑、正式保存与 Recovery Snapshot 编排）、`backupCommands.ts`（备份确认、来源/目标选择、flush、恢复与导出编排）、`annotationExportCommands.ts`（单本批注 Markdown 导出编排）、`searchStore.ts` / `searchRunner.ts`（当前材料搜索）、`positionPersister.ts`（阅读位置节流/flush）、`readerCommands.ts`（阅读命令）、`workbenchCommands.ts`（工作台命令）、`libraryStore.ts` / `libraryCommands.ts` / `importBook.ts`（书库与导入）、`annotationStore.ts` / `annotationCommands.ts`（批注）、`shellUiStore.ts`（外壳 UI 状态），及对应测试。 |
| `test/setup.ts` | Vitest 测试环境配置。 |

## 约定

- `AnnotationSidebar.tsx` 读取 Workspace Store 的主要阅读材料与批注 Store；指定主要材料、切换批注侧栏和批注跳转分别经稳定 Command 执行。

- 用户意图一律走 Command：UI 组件执行 Command，不在组件里另接行为逻辑；命令必须在 `commands/` 注册稳定 ID。
- 前端不接触 SQLite 表、SQL、数据库路径与文件细节；平台能力只经 typed Repository 接口调用 Rust 命令。
- 内存 Adapter 与 Tauri Adapter 必须运行同一份 `workspaceRepository.contract.ts` 契约测试；Repository 接口变化时同步更新契约与两个 Adapter。
- Workspace State 必须可序列化；Reader Runtime 活对象（视图、选区、加载任务）不得进入持久化状态。每个 Editor Group 仅保留活动阅读器，全应用最多两个活动渲染器。

## Readest 参照

实现任何前端模块（工作台布局、命令系统、存储适配、阅读视图等）前，先看 Readest 对应实现；有能直接复制的代码直接复制移植，并在 `docs/legal/third-party.md` 登记来源与许可。详见根 `AGENTS.md`。
