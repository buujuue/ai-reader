# `src/domain/library` — 书库与导入子域

## 功能

阅读材料领域模型与导入契约，是「托管导入一份 EPUB」的核心。

- `material.ts`：`ReadingMaterial`（稳定 BookId）、`StagedImport`（暂存句柄）、`SourceMetadata`（来源元数据快照）领域类型，serde 命名与 Rust 端 DTO 一致。
- `importRepository.ts`：typed 导入 Repository 接口（`stageImport` / `readStagedFile` / `commitImport` / `listMaterials` / `recoverImports`），是前端调用平台能力的窄边界。
- `tauriImportRepository.ts`：Tauri Adapter，经 `invoke` 调用 `stage_import` / `read_staged_file` / `commit_import` / `list_materials` / `recover_imports` 命令。
- `inMemoryImportRepository.ts`：内存 Adapter，浏览器降级开发用；用 sha256 模拟 Rust 完整内容指纹。
- `importRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的契约测试。
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
    ├── importBook.ts     编排 stage → inspect → commit
    └── libraryCommands.ts 经 ImportRepository 执行 `library.importOne` / `library.refresh`
```

## 依赖方向

该子域是导入契约的家：内存 Adapter 与 Tauri Adapter 必须运行同一份 `importRepository.contract.ts` 契约测试；接口变化时同步更新契约与两个 Adapter。Rust 侧 `ImportRepository` 在真实 SQLite 与托管文件系统上运行镜像契约。