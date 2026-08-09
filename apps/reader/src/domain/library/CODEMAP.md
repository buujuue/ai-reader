# `src/domain/library` — 书库与导入子域

## 功能

阅读材料领域模型与导入契约，是「托管导入一份 EPUB」的核心。

- `material.ts`：`ReadingMaterial`（稳定 BookId，含 `source` 来源快照、`override` 覆盖值与 `title/author/language/coverSource` 有效元数据）、`StagedImport`（暂存句柄）、`SourceMetadata` / `MaterialOverride` 领域类型，serde 命名与 Rust 端 DTO 一致。
- `materialFormat.ts`：`formatFromSourceFileName` 从源文件扩展名推断材料格式（epub/pdf/markdown/unknown），`formatLabel` 输出简体中文标签；不依赖跨 TS/Rust 契约新增字段。
- `libraryFilter.ts`：`filterMaterialsByQuery` 基于有效元数据（title/author）即时筛选书库的纯函数。
- `importRepository.ts`：typed 导入 Repository 接口，覆盖导入、书库、元数据、回收站、正式 Markdown 保存，以及 `writeMarkdownRecovery` / `listMarkdownRecoveries` / `discardMarkdownRecovery` 恢复快照协议；是前端调用平台能力的窄边界。
- `tauriImportRepository.ts`：Tauri Adapter，经 `invoke` 调用导入、书库、回收站、元数据、`save_markdown` 与三个 `*_markdown_recovery` typed 命令。
- `inMemoryImportRepository.ts`：内存 Adapter，浏览器降级开发用；用 sha256 模拟 Rust 完整内容指纹，并模拟 pending/ready 状态机、「来源快照 + 覆盖值」的有效元数据合并与回收站（普通删除只隐藏、恢复/永久删除）。
- `importRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的导入、正式 Markdown 保存与恢复快照契约测试。
- `metadataRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的元数据覆盖契约测试。
- `recycleBinRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的回收站契约测试。
- `importBatch.contract.ts`：内存与 Tauri 两个 Adapter 共享的批量导入契约测试。
- `epub/`：最小 ZIP 解析器（`zip.ts`）、`EpubInspector`（`epubInspector.ts`，BookDocument 雏形，解析 container.xml → OPF → 元数据/封面）、演示/测试夹具构造器（`zipWriter.ts`、`testEpub.ts`）。
- 对应 `*.test.ts`：Adapter 契约、Inspector 与编排测试。

## 依赖其它文件夹（树）

无（`domain/library/` 不依赖其它 `src/` 文件夹；`epubInspector` 复用平台 `DecompressionStream`）。

## 被谁依赖（树）

```
domain/library/
├── app/
│   ├── bootstrap.ts      选择并创建 ImportRepository 与演示源
│   └── filePicker.ts     选择文件后交给导入编排
└── workbench/
    ├── importBook.ts     批量编排 importBooks(多选、顺序 stage → inspect → commit)
    └── libraryCommands.ts 经 ImportRepository 执行 `library.import` / `library.refresh` / 元数据覆盖与回收站命令
```

## 依赖方向

该子域是导入契约的家：内存 Adapter 与 Tauri Adapter 必须运行同一份 `importRepository.contract.ts` 契约测试；接口变化时同步更新契约与两个 Adapter。Rust 侧 `ImportRepository` 在真实 SQLite 与托管文件系统上运行镜像契约。
