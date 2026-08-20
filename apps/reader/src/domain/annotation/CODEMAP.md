# `src/domain/annotation` — 批注（Annotation）子域

## 功能

- `annotation.ts`：领域类型。`Annotation`（`id` + `materialId` 归属 + `anchor` + `style` + `color` + `note` + 时间戳 + `deletedAt`）、`TextAnchor`（`cfi` + `quote` 引文 + `before`/`after` 前后文 + `documentVersion` 文档版本 + `recoveryState` 恢复状态）、`AnnotationStyle`。批注是材料级实体,不归属某个 ReadingView(ADR-0008)。
- `textAnchor.ts`：文本锚点构建与恢复逻辑。`buildTextAnchor` 从 DOM Range 与 CFI 构建已解析锚点;`extractQuote`/`extractContext` 提取引文与前后文;`findUniqueQuoteMatch` 在文档文本中做唯一引文 + 上下文匹配,用于文档变化后的锚点恢复；`recoverTextAnchor` 通过 `domain/reader/epubCfi.ts` 把回退限制在原 spine 章节。
- `annotationRepository.ts`：typed Repository 接口(`listByMaterial` / `saveAnnotation` / `deleteAnnotation`),前端调用平台能力的窄边界。
- `tauriAnnotationRepository.ts`：Tauri Adapter,经 `invoke` 调用 `list_annotations` / `save_annotation` / `delete_annotation` 命令,附 `assertAnnotationShape` 载荷校验。
- `inMemoryAnnotationRepository.ts`：内存 Adapter,浏览器降级开发用;按 materialId 归属并逻辑删除。
- `annotationRepository.contract.ts`：内存与 Tauri 两个 Adapter 共享的批注契约测试。
- `annotationMarkdown.ts`：把单本材料级批注格式化为 UTF-8 Markdown，包含材料元数据、文本引文、笔记、EPUB CFI/PDF 页码区域位置与失联状态；同时生成安全默认文件名。
- `annotationExportWriter.ts` / `tauriAnnotationExportWriter.ts` / `inMemoryAnnotationExportWriter.ts`：批注 Markdown 的 typed 文件写入边界及 Tauri/内存 Adapter。
- `annotationExportWriter.contract.ts`：批注导出写入器的共享契约测试。
- 对应 `*.test.ts`：Adapter 契约与文本锚点构建/恢复逻辑测试。

## 依赖其它文件夹（树）

`annotationMarkdown.ts` 复用 `domain/reader/pdf/pdfTextAnchor.ts` 解码扫描 PDF 区域锚点，`textAnchor.ts` 复用 `domain/reader/epubCfi.ts` 的同 spine CFI 规则；其余批注持久化类型与 Adapter 不依赖 UI 或工作台。

## 被谁依赖（树）

```
domain/annotation/
├── domain/reader/BookDocument 经窄接口读取/保存批注(选中→锚点→绘制)
└── workbench/annotationCommands.ts 与 annotationStore 协调批注读写与命令分发
```

## 依赖方向

批注归属由 `materialId` 表达,不依赖 ReadingView 标识。DOM Range 属于 Reader Runtime,本子域只接受其派生的可序列化字符串(引文/前后文/CFI),绝不把 Range 或渲染器对象写入持久化状态。
