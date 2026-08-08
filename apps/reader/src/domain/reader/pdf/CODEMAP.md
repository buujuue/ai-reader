# `src/domain/reader/pdf` — PDF 阅读子模块

## 功能

PDF 阅读内核，把 PDF.js 的全部能力封装在 `BookDocument` 窄接口之后，并落实工单 #14 验收标准（固定版式阅读、缩放/适配、视口恢复、扫描页无文字层显示、范围读取并发上限、过期渲染取消与画布内存预算）。

- `pdfLibrary.ts`：PDF.js 窄接口类型定义（`PdfJsLib`、`PdfDocumentProxy`、`PdfPage` 等）与懒加载引导 `loadPdfLib()`；加载时关闭 `isEvalSupported`，落实不可信内容安全边界（ADR-0010）。
- `pdfRangeTransport.ts`：范围读取传输层，限制 PDF.js 范围请求并发上限 `MAX_CONCURRENT_RANGES`，失败自动释放并发槽；供大文件范围读取使用。
- `pdfInspector.ts`：`inspectPdf` 做格式校验与元数据提取（标题/作者/页数），可注入伪引擎；错误分类覆盖空文件、无 PDF 头（unsupported）、损坏结构（corrupt）。
- `pdfPageRenderer.ts`：单页渲染器。DPI 夹紧（`MAX_RENDER_DPR`）、过期渲染取消（渲染令牌失效）、替换或卸载页面时释放 Canvas 位图面积与文本层资源。
- `pdfRenderer.ts`：布局管理器。分页/滚动两种流向、缩放与页面适配（宽度/高度/整页/实际大小）、滚动视口窗口化（只渲染视口附近的解码页）+ 画布内存预算、解码页 LRU 释放。
- `pdfBookDocument.ts`：`PdfBookDocument` 实现 `BookDocument`。统一暴露元数据、目录、导航、位置（`PdfReadingLocation`：page/scrollTop/zoom/fit）、滚动/缩放/适配、封面与 `close`；并提供 PDF 专属 `setViewport`（缩放/适配）。外部模块不直接操作 PDF.js 对象。

- 对应 `*.test.ts`：`pdfTestFakes.ts` 提供伪页面/文档/库/光栅化器；测试覆盖范围读取并发上限、翻页/滚动、缩放恢复、Canvas 内存预算、过期渲染取消、无文字层显示与错误 PDF。

## 依赖其它文件夹（树）

无（`pdf/` 不依赖其它 `src/` 文件夹；运行时经 `pdfjs-dist` 依赖渲染）。

## 被谁依赖（树）

```
domain/reader/pdf/
├── domain/reader/        由 BookDocument 契约统一消费 PdfBookDocument
└── workbench/
    ├── readerCommands.ts 按扩展名创建 PdfBookDocument 并接线 readerSetPdfViewport/readerSetPdfFlow 命令
    └── importBook.ts     经 pdfInspector.inspectPdf 校验与提取 PDF 元数据
```

## 依赖方向

`pdf/` 是 PDF 阅读语义的深模块：把所有对 PDF.js 的直接调用（加载、范围读取、渲染、画布/文本层释放）隔离在内部，通过 `PdfBookDocument`（实现 `BookDocument`）向上层提供窄接口。上层不得直接操作 PDF.js 对象。