# `src/domain/library/epub` — EPUB 检查（BookDocument 雏形）

## 功能

- `epubBudget.ts`：首版不可覆盖的单条目、总解压量、压缩比、章节、条目数与 XML/HTML 深度预算；测试契约直接复用该常量，避免规格漂移。
- `zip.ts`：有界 ZIP 解析器。解析中央目录与本地文件头，校验偏移、长度、重复/越界路径、ZIP 加密与条目一致性；支持 stored 与 deflate，复用平台 `DecompressionStream` 并在输出超限时取消读取。
- `epubInspector.ts`：`inspectEpub` 在 `stage → inspect → commit` 的 inspect 阶段验证 container.xml、OPF、manifest、spine、首个可读章节、DRM/字体混淆与硬资源预算；返回元数据、封面声明和章节/非核心资源/NAV-NCX 降级报告，整书失败抛稳定 `EpubInspectError`。
- `zipWriter.ts`：只用于测试夹具与浏览器降级开发的演示材料，构造 stored ZIP/EPUB 字节。
- `testEpub.ts`：测试用 EPUB 构造器（含 deflate 压缩路径夹具），复用 `zipWriter`。
- 对应 `*.test.ts`。

## 依赖其它文件夹（树）

无（`epub/` 不依赖其它 `src/` 文件夹；只复用平台 `DOMParser`、`DecompressionStream` 与本目录的 `epubBudget`）。

## 被谁依赖（树）

```
epub/
├── domain/library/       material.SourceMetadata;inspectEpub 供 ImportRepository 契约上游使用
├── app/bootstrap.ts      演示 EPUB（zipWriter.buildEpub）
├── workbench/importBook.ts 调用 inspectEpub 检查暂存文件并把报告带入导入结果
└── workbench/readerCommands.ts 打开托管 EPUB 前复用 inspectEpub
```

## 依赖方向

`epub/` 是最内层的格式检查与 ZIP 安全能力：`epubBudget` → `zip`/`epubInspector`，上层 `importBook` 只消费预检结果和稳定错误，不接触 ZIP 内部状态；它不依赖 UI、命令或工作台状态。
