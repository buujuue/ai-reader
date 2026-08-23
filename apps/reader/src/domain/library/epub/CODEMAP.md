# `src/domain/library/epub` — EPUB 检查（BookDocument 雏形）

## 功能

- `epubBudget.ts`：首版不可覆盖的单条目、总解压量、压缩比、章节、条目数与 XML/HTML 深度预算；测试契约直接复用该常量，避免规格漂移。
- `zip.ts`：有界 ZIP 解析器。解析中央目录与本地文件头，校验偏移、长度、重复/越界路径、ZIP 加密与条目一致性；支持 stored 与 deflate，复用平台 `DecompressionStream` 并在输出超限时取消读取；`openZipArchive` 通过 `ZipSource.slice()` 惰性读取目录和条目，并去重同条目的并发请求。
- `epubInspector.ts`：`inspectEpub` 接收 `File/Blob` 兼容 Source，在 `stage → inspect → commit` 的 inspect 阶段验证 container.xml、OPF、manifest、spine、首个可读章节、DRM/字体混淆与硬资源预算；元数据和封面可观察结果由 foliate-js/OPF 结构产生，检查器只负责安全预算与报告，来源封面解码/转换失败以非阻塞 `coverWarning` 返回，整书失败才抛稳定 `EpubInspectError`。
- `zipWriter.ts`：只用于测试夹具与浏览器降级开发的演示材料，构造 stored ZIP/EPUB 字节。
- `testEpub.ts`：测试用 EPUB 构造器（含 deflate 压缩路径夹具），复用 `zipWriter`。
- 对应 `*.test.ts`。

## 依赖其它文件夹（树）

`epub/` 复用 `domain/reader/foliateEpubLoader.ts` 的 Foliate 语义读取入口；底层 ZIP 与安全预算仍由本目录拥有，避免检查器复制 EPUB 语义。

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
