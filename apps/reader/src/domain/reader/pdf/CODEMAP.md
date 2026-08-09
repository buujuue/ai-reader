# `src/domain/reader/pdf` — PDF 阅读子模块

## 功能

PDF 阅读内核，把 PDF.js 的全部能力封装在 `BookDocument` 窄接口之后，并落实工单 #14（固定版式阅读、缩放/适配、视口恢复、扫描页无文字层显示、范围读取并发上限、过期渲染取消与画布内存预算）与工单 #15（Canvas 与文本层对齐、文本选择与复制、当前材料搜索、文本高亮与批注、PDF 文本锚点）的验收标准。

- `pdfLibrary.ts`：PDF.js 窄接口类型定义（`PdfJsLib`、`PdfDocumentProxy`、`PdfPage` 等）与懒加载引导 `loadPdfLib()`；加载时关闭 `isEvalSupported`，落实不可信内容安全边界（ADR-0010）。文本内容项携带 `transform`/`width`/`height` 几何数据，供文本层定位。
- `pdfRangeTransport.ts`：范围读取传输层，限制 PDF.js 范围请求并发上限 `MAX_CONCURRENT_RANGES`，失败自动释放并发槽。当前 `PdfBookDocument.open` 直接持有完整字节并经 `data` 打开（见下），该传输保留为未来「原生文件桥接」大文件范围读取的能力（spec/ADR-0010 记录的设计）。
- `pdfInspector.ts`：`inspectPdf` 做格式校验与元数据提取（标题/作者/页数），可注入伪引擎；错误分类覆盖空文件、无 PDF 头（unsupported）、损坏结构（corrupt）。XMP 元数据（`dc:creator` 等多作者）可能返回数组，统一归一化为 `string | null`（以「、」连接），避免传给 Rust `commit_import` 时序列化失败。
- `pdfTextLayer.ts`：文本层定位。把文本项 transform 换算成与 Canvas 对齐的绝对定位 span（参考 pdf.js `TextLayer`），使文本可选、可复制。
- `pdfTextAnchor.ts`：PDF 文本锚点编解码。用「页码 + 归一化矩形」表达定位，支持与 `TextAnchor` 的引文/前后文/文档版本组合，并提供扫描页拖拽端点的归一化。
- `pdfSearch.ts`：PDF 文本搜索。逐页读取文本内容、普通文本匹配、产出进度与命中（含页码 + 归一化矩形锚点），可取消；扫描页不误报命中。
- `pdfPageRenderer.ts`：单页渲染器。DPI 夹紧（`MAX_RENDER_DPR`）、过期渲染取消（渲染令牌失效）、替换或卸载页面时释放 Canvas 位图面积与文本层资源；构建对齐文本层，并提供批注/搜索高亮覆盖层（按归一化矩形绘制，重渲染后重绘）；扫描页显示提示并通过指针拖拽回传区域选择。
- `pdfRenderer.ts`：布局管理器。分页/滚动两种流向、缩放与页面适配（宽度/高度/整页/实际大小）、滚动视口窗口化（只渲染视口附近的解码页）+ 画布内存预算、解码页 LRU 释放；暴露按页设置高亮的方法。
- `pdfBookDocument.ts`：`PdfBookDocument` 实现 `BookDocument`。统一暴露元数据、目录、导航、位置（`PdfReadingLocation`）、滚动/缩放/适配、封面与 `close`；接入 `search`/`clearSearch`、`getCFI`/`getAreaAnchor`/`getCurrentIndex`、`addAnnotation`/`removeAnnotation`/`onShowAnnotation`/`onAreaSelection`、`getContentDocs`/`onContentCreate`，并管理批注与搜索高亮的重绘。文本选区从所属 PDF 页生成锚点，扫描页区域选择向上层回传页码与归一化矩形。`open` 直接持有完整字节并经 `getDocument({ data })` 打开（与 `inspectPdf` 一致，先复制字节避免 ArrayBuffer 被 PDF.js 转移脱离）。外部模块不直接操作 PDF.js 对象。

- 对应 `*.test.ts`：`pdfTestFakes.ts` 提供伪页面/文档/库/光栅化器（含可注入文本项）；测试覆盖范围读取并发上限、翻页/滚动、缩放恢复、Canvas 内存预算、过期渲染取消、无文字层显示、文本层定位、搜索、锚点编解码、PDF 批注与错误 PDF。

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
