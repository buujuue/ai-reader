# `src/domain/library` — 书库与导入子域

## 功能

阅读材料领域模型与导入契约，是「托管导入一份 EPUB」的核心。

- `material.ts`：`ReadingMaterial`（稳定 BookId，含唯一 `folderId` 归属、`source` 来源快照、`override` 覆盖值、有效元数据和托管副本可用状态）、`StagedImport`（暂存句柄）、`SourceMetadata` / `MaterialOverride` 领域类型，serde 命名与 Rust 端 DTO 一致。
- `cover.ts`：来源封面安全边界；限制字节预算，清洗 SVG，并在需要时按原始宽高比缩放到长边 512、以 JPEG 质量 85 输出。
- `materialFormat.ts`：`formatFromSourceFileName` 从源文件扩展名推断材料格式（epub/pdf/markdown/unknown），`formatLabel` 输出简体中文标签；不依赖跨 TS/Rust 契约新增字段。
- `libraryFilter.ts`：`filterMaterialsByQuery` 基于有效元数据（title/author）即时筛选书库的纯函数。
- `libraryFolder.ts`：书库文件夹稳定身份、显式父级、名称清理/校验、五层深度和稳定排序规则。
- `libraryFolderRepository.ts` / `inMemoryLibraryFolderRepository.ts` / `tauriLibraryFolderRepository.ts`：独立的文件夹 typed Repository、浏览器内存 Adapter 与 Tauri Adapter；创建/改名不接触 UI、SQL 或数据库路径。
- `libraryFolderRepository.contract.ts` 与对应测试：内存/Tauri Adapter 共用的文件夹新增、排序、重名、非法名称、改名和五层契约。
- `importRepository.ts`：typed 导入 Repository 接口，覆盖导入、书库、单本材料文件夹归属、元数据、回收站、同指纹托管副本重新关联、正式 Markdown 保存、Markdown 恢复快照，以及显式 EPUB 版本迁移和迁移前恢复快照协议；是前端调用平台能力的窄边界。Markdown、EPUB 与 PDF 打开统一使用 `openManagedFileSource`，生产阅读边界不提供通用全量读取；导入暂存、封面和明确的完整文本快照仍走各自专用协议。
- `managedFileSource.ts`：只读、File/Blob 兼容的托管材料范围来源；维护 128 KiB 分块、128 块 LRU 和同分块并发 Promise，不知道 Tauri 或文件路径。
- `managedRangeProtocol.ts`：Windows Tauri PDF 的 `MaterialId + 半开范围` 二进制 WebView fetch 适配；只负责协议 URL、平台选择和响应长度校验，不接触数据库或托管路径。
- `tauriImportRepository.ts`：Tauri Adapter，经 `invoke` 调用导入、书库、回收站、同指纹 `relink_material`、元数据、`save_markdown`、Markdown 恢复、版本迁移和非 Windows/非 PDF 的托管材料范围命令；Windows PDF 的范围回调切换到 `managedRangeProtocol.ts`，并校验跨端 DTO 形状。
- `backupRepository.ts` / `inMemoryBackupRepository.ts` / `tauriBackupRepository.ts`：完整书库备份 typed Repository、内存测试 Adapter 与 Tauri Adapter；只传递目标路径和导出结果，不把 SQLite、托管文件或归档字节带入前端。
- `inMemoryImportRepository.ts`：内存 Adapter，浏览器降级开发用；用 sha256 模拟 Rust 完整内容指纹，并按「完整指纹 + 格式」模拟 pending/ready 查重、来源快照/覆盖值合并、来源封面与自定义封面分层、托管副本缺失后的重新关联与回收站（普通删除移除正文副本、恢复/永久删除同步清理迁移快照）。
- `importRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的导入、正式 Markdown 保存与恢复快照契约测试。
- `metadataRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的元数据覆盖契约测试。
- `recycleBinRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的回收站契约测试。
- `backupRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的备份导出契约测试。
- `importBatch.contract.ts`：内存与 Tauri 两个 Adapter 共享的批量导入契约测试。
- `versionMigration.ts`：显式版本迁移候选筛选、EPUB 新版本预览、同 spine 唯一引文重锚与进度/批注结果汇总；只读 Repository 数据，不执行提交。
- `versionMigrationPersistence.ts`：版本迁移提交、恢复快照和恢复结果的 typed 载荷。
- `epub/`：EPUB 预检与读取边界。`epubBudget.ts` 持有不可覆盖的 ZIP/章节/XML 硬预算；`zip.ts` 做中央目录、本地头、路径、加密、边界和有上限解压；`epubInspector.ts` 在 commit 前验证 container.xml → OPF → manifest/spine/首章，并返回章节、非核心资源与 NAV/NCX 局部降级报告；`zipWriter.ts`、`testEpub.ts` 为演示与测试夹具构造器。
- 对应 `*.test.ts`：Adapter 契约、Inspector 与编排测试。

## 依赖其它文件夹（树）

`domain/library/` 只依赖 `domain/reader/` 的 Foliate EPUB 语义入口和平台 API；`libraryFolder.ts` 与文件夹 Repository 不依赖阅读器运行时；`cover.ts` 的封面派生仍由本域拥有，`epub/` 复用平台 `DOMParser`、`DecompressionStream` 与本目录的预算契约。

## 被谁依赖（树）

```
domain/library/
├── app/
│   ├── bootstrap.ts      选择并创建 ImportRepository、BackupRepository 与演示源
│   └── filePicker.ts     选择文件后交给导入编排
└── workbench/
    ├── importBook.ts     批量编排 importBooks(多选、顺序 stage → inspect → commit)
    ├── readerCommands.ts 打开托管材料前复用 EPUB 预检
    └── libraryCommands.ts 经 ImportRepository 与 LibraryFolderRepository 执行 `library.import` / `library.refresh` / 元数据覆盖、回收站和文件夹命令

backupRepository ──► workbench/backupCommands.ts 经 typed 命令编排备份
managedFileSource ──► tauriImportRepository.ts / inMemoryImportRepository.ts 提供惰性正文来源
managedRangeProtocol ──► tauriImportRepository.ts（仅 Windows Tauri PDF 的二进制范围回调）
```

## 依赖方向

该子域是导入与备份契约的家：内存 Adapter 与 Tauri Adapter 必须分别运行同一份 `importRepository.contract.ts` 与 `backupRepository.contract.ts` 契约测试；接口变化时同步更新契约与两个 Adapter。`epub/` 是导入前的只读格式/安全边界，不依赖 Repository 或 UI；Rust 侧 `ImportRepository` 在真实 SQLite 与托管文件系统上运行镜像契约。
## 完整书库备份恢复

`backupRepository.ts` 定义完整备份导出与恢复的窄接口；`tauriBackupRepository.ts` 将恢复请求映射到 typed Tauri command，`inMemoryBackupRepository.ts` 为浏览器降级运行时提供契约测试适配。恢复由 Rust 校验、暂存、快照和原子切换，前端只负责选择备份文件、确认整库替换并刷新工作台。
