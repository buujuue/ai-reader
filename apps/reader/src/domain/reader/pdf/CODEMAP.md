# `src/domain/reader/pdf` — PDF 阅读子模块

## 功能

PDF 阅读内核，把 PDF.js 的全部能力封装在 `BookDocument` 窄接口之后，并落实工单 #14（固定版式阅读、缩放/适配、视口恢复、扫描页无文字层显示、范围读取并发上限、过期渲染取消与画布内存预算）、工单 #15（Canvas 与文本层对齐、文本选择与复制、当前材料搜索、文本高亮与批注、PDF 文本锚点）和工单 #40（导入检查阶段渲染首页来源封面、封面失败非阻塞与资源释放）的验收标准。

- `pdfLibrary.ts`：PDF.js 窄接口类型定义（`PdfJsLib`、`PdfDocumentProxy`、`PdfPage` 等）与懒加载引导 `loadPdfLib()`；加载时关闭 `isEvalSupported`，落实不可信内容安全边界（ADR-0010）。文本内容项携带 `transform`/`width`/`height` 几何数据，供文本层定位。
- `pdfRangeTransport.ts`：范围读取传输层，限制 PDF.js 范围请求并发上限 `MAX_CONCURRENT_RANGES`，支持挂起时暂停排队、恢复、队列取消、等待在途读取归零、越界拒绝、读取失败后的槽位释放与结果抑制，并通过 `PdfRangeReadError`/`withRangeFailure` 向打开和检查边界报告失败范围。
- `pdfErrors.ts`：把 PDF.js 打开阶段的初始化/结构损坏/托管范围错误与已打开页面的读取/渲染错误分别转换为稳定的简体中文 `PdfOpenError`/`PdfReadError`；原始错误仅保留给日志，不直接暴露给阅读界面。
- `pdfInspector.ts`：`inspectPdf` 接收 PDF 范围来源并通过同一范围传输做格式校验、元数据提取（标题/作者/页数）和首页来源封面派生，可注入伪引擎；封面失败只返回可诊断警告，不阻断正文检查。错误分类覆盖空文件、无 PDF 头（unsupported）、损坏结构（corrupt）。XMP 元数据（`dc:creator` 等多作者）可能返回数组，统一归一化为 `string | null`（以「、」连接），避免传给 Rust `commit_import` 时序列化失败。
- `pdfCover.ts`：一次性渲染 PDF 页面为临时 PNG，限制首页 Canvas 长边、检测透明空白页，并在完成/失败/取消时统一取消渲染任务、释放 Canvas 位图和调用 `page.cleanup()`；导入检查与 `PdfBookDocument.getCover()` 共用该生命周期 helper。
- `pdfTextLayer.ts`：文本层定位。把文本项 transform 换算成与 Canvas 对齐的绝对定位 span（参考 pdf.js `TextLayer`），使文本可选、可复制。
- `pdfTextAnchor.ts`：PDF 文本锚点编解码。用「页码 + 归一化矩形」表达定位，支持与 `TextAnchor` 的引文/前后文/文档版本组合，并提供扫描页拖拽端点的归一化。
- `pdfSearch.ts`：PDF 文本搜索。逐页读取文本内容、普通文本匹配、产出进度与命中（含页码 + 归一化矩形锚点），可取消；扫描页不误报命中。
- `pdfPageRenderer.ts`：单页渲染器。DPI 夹紧（`MAX_RENDER_DPR`）、过期渲染取消（渲染令牌失效）、替换或卸载页面时释放 Canvas 位图面积与文本层资源；构建对齐文本层，并提供批注/搜索高亮覆盖层（按归一化矩形绘制，重渲染后重绘）；当前页面的图像读取/渲染失败向上层传播，可选文本层失败记录诊断但保留扫描页图像；维护页面文字可选状态，并通过指针拖拽回传扫描页区域选择，不额外覆盖提示浮层。
- `pdfRenderer.ts`：布局管理器。分页/滚动两种流向、缩放与页面适配（宽度/高度/整页/实际大小）；分页模式在当前页完成后取得并预渲染下一页，翻页复用脱离 DOM 的结果，只保留当前页和下一页的渲染器；滚动模式先为全部页面建立默认尺寸占位，再由 `IntersectionObserver` 标记预加载范围，按距离优先调度页面读取/Canvas/文字层渲染（最多 3 个在途），真实页面尺寸到达后增量修正布局并恢复页内比例锚点，最多保留 12 个已渲染页面且优先释放最远不可见页；通过布局代次、显式恢复代次和 attach/detach 观察器代次丢弃过期异步结果，避免旧容器或旧加载任务改写当前页；同时负责画布内存预算、解码页 LRU 释放、缩放/位置竞态与资源取消，并在挂起/恢复时断开观察器、暂停范围队列、收缩到当前页，暴露按页设置高亮和资源快照的方法。
- `pdfBookDocument.ts`：`PdfBookDocument` 实现 `BookDocument`。统一暴露元数据、目录、导航、位置（`PdfReadingLocation`）、滚动/缩放/适配、封面与 `close`；接入 `search`/`clearSearch`、`getCFI`/`getAreaAnchor`/`getCurrentIndex`/`getPageCount`、`addAnnotation`/`removeAnnotation`/`onShowAnnotation`/`onAreaSelection`、`getContentDocs`/`onContentCreate`，并管理批注与搜索高亮的重绘。文本选区从所属 PDF 页生成锚点，扫描页区域选择向上层回传页码与归一化矩形。`open` 只在阅读挂载阶段通过 `PDFDataRangeTransport` 创建一份 PDF.js 文档，使用构造时传入的书库有效元数据，并读取目录、位置和首屏；`attach/detach` 复用 PDF.js 文档和当前页资源，异步 detach 会等待范围传输收敛，超时则让上层拒绝缓存并关闭重建；显式位置恢复按最新代次屏蔽中间页码/滚动事件，范围读取/初始化/结构错误统一经 `PdfOpenError` 交给工作台，打开取消会销毁加载任务与范围队列。外部模块不直接操作 PDF.js 对象。
- 对应 `*.test.ts`：`pdfTestFakes.ts` 提供伪页面/文档/库/光栅化器（含可注入文本项）；测试覆盖范围读取并发上限、翻页/滚动、数百页占位首屏、混合尺寸锚点修正、IntersectionObserver 最近页优先、快速滚动并发上限、12 页渲染淘汰、缩放恢复、Canvas 内存预算、过期渲染取消、首页封面渲染/空白页/资源释放、无文字层显示、文本层定位、搜索、锚点编解码、PDF 批注与错误 PDF。

## 依赖其它文件夹（树）

```text
domain/reader/pdf/
└── domain/library/
    └── cover.ts        复用来源封面安全解码、缩放与 MIME 标准化
```

运行时经 `pdfjs-dist` 依赖 PDF 解码与渲染；PDF 子模块不依赖书库 Repository 或持久化实现。

## 被谁依赖（树）

```
domain/reader/pdf/
├── domain/reader/        由 BookDocument 契约统一消费 PdfBookDocument
└── workbench/
    ├── readerCommands.ts 按扩展名创建 PdfBookDocument 并接线 readerSetPdfViewport/readerSetPdfFlow 命令
    └── importBook.ts     经 pdfInspector.inspectPdf 校验、提取 PDF 元数据并提交首页来源封面；阅读打开不再调用检查器
```

## 依赖方向

`pdf/` 是 PDF 阅读语义的深模块：把所有对 PDF.js 的直接调用（加载、范围读取、渲染、画布/文本层释放）隔离在内部，通过 `PdfBookDocument`（实现 `BookDocument`）向上层提供窄接口。上层不得直接操作 PDF.js 对象。
