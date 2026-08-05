# `src/domain/library/epub` — EPUB 检查（BookDocument 雏形）

## 功能

- `zip.ts`：最小 ZIP 解析器。解析中央目录与本地文件头，按名称读取单条目；支持 stored 与 deflate（复用平台 `DecompressionStream`）。只做按需单条目读取，不整包解压。
- `epubInspector.ts`：`inspectEpub` 解析 container.xml → OPF，提取来源元数据（标题/作者/语言）与封面存在性；损坏文件抛 `EpubInspectError` 领域化错误。这是 BookDocument 的雏形，不接触渲染器。
- `zipWriter.ts`：只用于测试夹具与浏览器降级开发的演示材料，构造 stored ZIP/EPUB 字节。
- `testEpub.ts`：测试用 EPUB 构造器（含 deflate 压缩路径夹具），复用 `zipWriter`。
- 对应 `*.test.ts`。

## 依赖其它文件夹（树）

无（`epub/` 不依赖其它 `src/` 文件夹；`epubInspector` 复用平台 `DOMParser` 与 `DecompressionStream`）。

## 被谁依赖（树）

```
epub/
├── domain/library/       material.SourceMetadata;inspectEpub 供 ImportRepository 契约上游使用
├── app/bootstrap.ts      演示 EPUB（zipWriter.buildEpub）
└── workbench/importBook.ts 调用 inspectEpub 检查暂存文件
```

## 依赖方向

`epub/` 是最内层的格式检查能力：`importBook` 与导入编排在它之上运行。它不依赖 UI、命令或工作台状态。