# `src/domain/reader/markdown` — Markdown 阅读子模块

## 功能

Markdown 作为一等阅读材料的阅读内核，落实工单 #17（安全导入并阅读 Markdown）与 ADR-0004 / ADR-0009。它把 Markdown 解析、清洗、按一级标题分段并组装成内存 EPUB，再复用 Foliate 分页器渲染，从而复用既有分页、搜索、目录、导航与排版能力。

- `markdownParser.ts`：`parseMarkdown` 渲染 Markdown → `marked` → `sanitizeHtmlFragment` 清洗 → 按一级标题切分章节；`parseFrontmatter` 提取 `title`/`author` 来源元数据。
- `markdownInspector.ts`：`inspectMarkdown` 导入检查（空/不可读分类、标题提取与文件名兜底）、`readableNameFromFileName`。`MarkdownInspectError` 领域化错误。
- `markdownEpub.ts`：`buildMarkdownEpub` 把已清洗的章节组装成最小 stored 内存 EPUB（含 mimetype/container/OPF/nav/章节）；自带最小 stored-zip 写入器，保持本域不依赖 `domain/library`。
- `markdownBookDocument.ts`：`MarkdownBookDocument` 在打开前把 Markdown 转成内存 EPUB，再复用 `EpubBookDocument` 的 Foliate 宿主封装；`format` 为 `'markdown'`，`ReadingLocation` kind 为 `'markdown'`。
- 对应 `*.test.ts`：解析、检查、BookDocument 与内存 EPUB 校验（用伪宿主，不依赖真实浏览器渲染）；恶意 Markdown fixture 安全测试在 `sanitizer.test.ts` 与 `markdownParser.test.ts`。

安全边界（ADR-0010）：Markdown 渲染结果一律视为不可信输入，`sanitizeHtmlFragment` 移除脚本、iframe、对象嵌入、事件处理器与危险 URL；清洗发生在进入任何渲染器之前。

## 依赖其它文件夹

- `../epubBookDocument.ts` / `../viewHost.ts`：复用 Foliate 视图宿主封装与 `FoliateViewHostFactory`。
- `../sanitizer.ts`：`sanitizeHtmlFragment` 内容清洗。
- `../bookDocument.ts`：`BookDocument` 元数据类型。
- `../../library/material.ts`：`SourceMetadata` 类型（导入检查输出）。

## 被谁依赖

```
domain/reader/markdown/
├── workbench/readerCommands.ts  按格式创建 MarkdownBookDocument 并接线命令
└── workbench/importBook.ts      按扩展名分派 inspectMarkdown 完成导入
```

## 依赖方向

`markdown/` 是 Markdown 阅读语义的深模块：把所有对 Markdown 解析、清洗、EPUB 组装与 Foliate 渲染的直接调用隔离在内部，通过 `BookDocument`（`MarkdownBookDocument`）向上层提供窄接口。上层不得直接操作 `marked`、内存 EPUB 或 Foliate View。