# `src/domain` — 领域模型与持久化边界

## 功能

领域层定义可序列化的领域模型与 typed Repository 接口，是前端与 Rust 平台核心之间的契约边界。当前含 `workspace/`（工作区）、`library/`（书库与导入）、`annotation/`（批注）与 `reader/`（阅读文档）四个子域。

## 子目录

- `workspace/`：工作区状态模型（Editor Group、阅读视图、阅读位置）、Repository 接口及内存/Tauri 两个 Adapter。详见 `workspace/CODEMAP.md`。
- `library/`：阅读材料与书库文件夹领域模型、带唯一文件夹归属移动能力的导入 Repository、独立 `LibraryFolderRepository`、内建最小 `EpubInspector`（BookDocument 雏形）及内存/Tauri 两个 Adapter。详见 `library/CODEMAP.md`。
- `annotation/`：材料级批注、版本化文本锚点与 Annotation Repository；负责锚点恢复规则，不依赖具体阅读渲染器。详见 `annotation/CODEMAP.md`。
- `reader/`：`BookDocument` 统一文档接口、`ReadingLocation`、`EpubBookDocument` 与 `PdfBookDocument` 实现、Foliate 视图宿主窄缝、EPUB 内容清洗器与 `pdf/` PDF 阅读子模块。详见 `reader/CODEMAP.md`。
- `tauriInvoke.ts`：`TauriInvoke` 窄接口类型，供各 Tauri Adapter 复用。

## 依赖其它文件夹（树）

无（领域层不依赖 UI、命令或工作台组件）。

## 被谁依赖（树）

```
domain/
├── app/
│   ├── bootstrap.ts      创建 Workspace/Import Repository 与 FilePicker,注册 Reader 命令
│   └── filePicker.ts     系统文件选择器窄接口
├── components/
│   └── ReadingView.tsx   经 BookDocument/Reader Runtime 挂载阅读视图
└── workbench/
    ├── workbenchCommands.ts  经 WorkspaceRepository 持久化状态
    ├── libraryCommands.ts    经 ImportRepository 与 LibraryFolderRepository 执行导入、材料归类与文件夹命令
    ├── readerCommands.ts     经 ImportRepository + BookDocument 执行打开/翻页/关闭命令
    ├── annotationCommands.ts 经 AnnotationRepository + BookDocument 执行批注读写与锚点恢复
    ├── readerRuntime.ts      持有活 BookDocument 对象
    ├── importBook.ts         编排 stage → inspect → commit
    ├── workspaceStore.ts     引用 WorkspaceState 与默认状态
    └── libraryStore.ts       引用 ReadingMaterial 与 LibraryFolder
```

## 依赖方向

`domain/` 是最内层、无外部依赖的深模块；它定义契约，由 `workbench/`、`components/` 与 `app/` 消费。前端不接触 SQLite 表、SQL 或数据库路径，平台能力只经 `domain/` 的 typed Repository 接口调用 Rust 命令。`reader/` 内所有对具体渲染器（Foliate View）的直接调用都集中在 `foliateViewHost.ts`，上层只通过 `BookDocument` 窄接口交互。
