# `src/domain/reader` — 阅读文档子域

## 功能

- `bookDocument.ts`：`BookDocument` 统一文档接口（元数据、打开/重新挂载/摘下、位置读写、目录、书内链接跳转、书内/外部链接事件、下一页/上一页、搜索、批注 CFI 无位置解析、可选的内容文档到 spine section 映射、位置订阅、可序列化阅读位置反馈订阅、打开后读取/渲染错误订阅、关闭；以及 `getContentDocs`/`onContentCreate` 暴露内容文档用于附加阅读输入监听器、Runtime 资源快照，并为 PDF 提供可选的区域锚点与区域选区订阅）。EPUB、PDF、Markdown 都实现该接口；Reader 外部不直接依赖 Foliate View。
- `toc.ts`：`TocItem`/`Toc` 类型，与 foliate-js `book.toc` 结构一致的分层目录。
- `derivedToc.ts`：原生 NAV/NCX 缺失或不可导航时，从受预算限制的章节 `h1`–`h6` 标题生成带层级和稳定章节目标的本地临时目录；按完整内容指纹与算法版本读写小型本地缓存，缓存损坏只触发重建。缓存只经 `EpubDerivedTocCache` 窄接口访问。
- `derivedTocCacheContract.ts`：内存与 Tauri 推导目录缓存 Adapter 共用的行为契约测试辅助，验证未命中、写入、覆盖和 key 隔离。
- `navigationHistory.ts`：每个 ReadingView 的可序列化导航历史（最多 50 个节点）。显式跳转 `pushExplicit` 新增节点、普通翻页 `replaceCurrent` 替换当前节点、`back`/`forward` 后退前进；纯数据结构，可随工作区持久化。
- `readingLocation.ts`：可序列化的 `ReadingLocation`（第一版为 EPUB CFI）与形状校验。
- `readingProgress.ts`：把 Foliate 的当前位置投影为可序列化的章节、页码、目录标签与百分比，并提供阅读位置反馈的格式化文本；不把 Range 或渲染器对象带入 Workspace State。
- `typography.ts`：阅读排版设置（字体、字号、行距、页边距、主题、分页/滚动）。定义完整设置 `ReadingTypography`、全局默认 `DEFAULT_READING_TYPOGRAPHY`、材料级覆盖与全局默认的合并规则 `resolveTypography`，以及把排版注入文档的 `buildTypographyCss`。字体与颜色全部来自固定映射，不拼接不可信字符串，落实 ADR-0010 不放开安全边界。
- `sanitizer.ts`：不可信阅读资源清洗器。`sanitizeEpubResource` 统一处理 XHTML/HTML、SVG、CSS 与脚本 MIME；永久移除脚本、iframe、object、embed、表单、音视频媒体、事件处理器属性、远程/危险 URL 和可执行 CSS，落实 ADR-0010。清洗是打开 EPUB 的必经步骤，无"信任此书"开关。
- `epubCanonical.ts`：规范 EPUB 转换入口与版本化派生缓存键。原书完整指纹和转换版本进入缓存键；清洗结果只作为阅读、搜索与 CFI 所见 DOM 的派生数据，排版设置不参与转换。
- `canonicalSearch.ts`：按章节建立规范可读文本、文本偏移到 DOM Range 的映射和版本化搜索索引快照；普通搜索与安全正则共用字符预算、结果上限、章节超时和取消错误边界，正则实际在可终止 Worker 中执行，脚本、模板、CFI 忽略节点及展示辅助节点不进入结果，缓存损坏或版本变化只触发重建。
- `epubCfi.ts`：EPUB CFI 的 spine 前缀解析与同章判断，供文本锚点回退限制在原章节内。
- `epubBookDocument.ts`：`EpubBookDocument` 实现。持有只读 `File/Blob` 兼容 Source，把不可信内容清洗、Foliate 渲染器挂载、位置读取/恢复、目录读取、href 导航与书内/外部链接事件封装在窄接口后；`wireSecurity` 在文本资源进入渲染器前清洗各已知 MIME，把 relocate 事件转成 `ReadingLocation` 和可序列化进度反馈，并把书内/外部链接事件面向上层。
- `foliateEpubLoader.ts`：把受预算的惰性 ZIP loader 适配为 foliate-js EPUB loader；只读取中央目录和实际请求的条目，可选原生预取只覆盖已校验的 container/OPF/NAV/NCX 文本和资源尺寸，其余章节与资源继续按需读取；导入预检提取语义快照后显式销毁临时 Foliate loader。
- `nativeEpub.ts` / `tauriEpubNative.ts`：定义原生 EPUB 预取协议、平台/能力/语义来源门控、错误分类与 Tauri Adapter；任意不支持、协议不匹配或 IPC 失败均返回纯 JS 路径。
- `tauriDerivedTocCache.ts`：把 EPUB 推导目录缓存映射到 Rust 私有文件的 typed Tauri 命令；浏览器降级使用 `derivedToc.ts` 的内存 Adapter。
- `viewHost.ts` / `foliateViewHost.ts`：`FoliateViewHost` 窄接口与 `FoliateViewHostFactory` 工厂。生产实现懒加载 `foliate-js` 的 `view.js` 并创建 `foliate-view` 元素；测试注入伪宿主。提供 `getTOC`/`goToHref`/`onInternalLink`/`onExternalLink`，以 preventDefault 阻止书内与外部链接的默认导航，把 href/URL 面向上层统一处理；`search`/`clearSearch` 把 foliate 的原始搜索产出归一化为领域事件并委托高亮；`canResolveAnnotation` 只在不改变阅读位置的前提下验证当前已加载章节的原 CFI；`getContentDocumentIndex` 把内容文档映射到 spine section 供单章节批注校验；`applyTypography` 把排版经分页器 attribute（flow/gap/margin/max-inline-size/max-block-size/max-column-count）与可选 `setStyles` 注入文档，以兼容固定版式渲染器；当前位置从 Foliate `lastLocation` 归一化为进度反馈，固定版式还提供当前 spread 索引回退；`getContentDocs`/`onContentCreate` 暴露内容文档（iframe 内）供上层附加统一阅读输入监听器，并对不可见 MathML 做局部可理解降级；attach/detach 支持挂起 Runtime 无损重新挂载。所有对具体渲染器的直接调用都集中在本层。
- `mathmlFallback.ts`：检测浏览器无法绘制的 MathML，仅替换不可见公式为带 `role="img"` 和可读文本的本地 fallback；可渲染的原生 MathML 保持不变。
- `readingInput.ts`：阅读输入统一层。纯解释器（`interpretKeyboard`/`interpretWheel`/`interpretTap`/`interpretSwipe`）把键盘、滚轮、点击、滑动归一化为"翻一页"意图；`WheelPageGate` 保证一次滚轮/惯性手势最多翻一页；`isInteractiveElement` 与扫描页区域选择识别优先保护交互控件、文本选择和拖选；`ReadingInputController` 把解释结果收敛到稳定 Command ID 分发（不依赖 Command Registry），并通过可指定正文根节点的 `attach` 接收 DOM 事件，PDF 顶层文档只在当前 ReadingView 容器内生效，分页模式下抑制原生触摸滑动并去掉兼容 click 双翻页。
- 对应 `*.test.ts`：清洗器、`EpubBookDocument`、阅读进度、MathML 降级、搜索归一化与排版合并/建 CSS 行为测试；EPUB P0 语义矩阵另在 `src/test/fixtures/epub/` 使用 Foliate loader 验证目录、固定版式与方向语义。
- `search.ts`：当前材料搜索的领域类型（`SearchExcerpt`、`SearchMatch`、`SearchEvent`、`SearchOptions`、`SearchMode`）。搜索只针对当前激活 ReadingView，不跨书建索引。
- 对应 `*.test.ts`：清洗器、`EpubBookDocument` 与搜索归一化行为测试（伪宿主）；EPUB 2/3 P0 语义矩阵位于 `src/test/fixtures/epub/`。
- `pdf/`：PDF 阅读子模块。`pdfLibrary.ts` 定义 PDF.js 窄接口类型、共享 `PdfFileSource` 与可销毁加载任务，并提供懒加载引导（`isEvalSupported:false` 安全边界）；`pdfRangeTransport.ts` 实现范围读取并发上限（`MAX_CONCURRENT_RANGES`）、取消、越界保护与失败收敛；`pdfInspector.ts` 的 `inspectPdf` 做范围检查、格式校验、元数据提取与首页来源封面派生；`pdfCover.ts` 统一一次性首页渲染、空白页诊断、渲染取消和 Canvas/页面释放；`pdfPageRenderer.ts` 单页渲染器（DPI 夹紧、过期渲染取消、替换/卸载释放画布位图与文本层、扫描页区域拖选）；`pdfRenderer.ts` 布局管理器（分页/滚动、缩放与页面适配、滚动窗口化 + 画布内存预算，仅渲染视口附近的解码页）；`pdfBookDocument.ts` 的 `PdfBookDocument` 实现 `BookDocument`（元数据/目录/导航/位置/缩放/适配/封面 + PDF 专属 `setViewport`、文本/区域锚点、读取错误订阅），检查与阅读共享同一个托管范围来源。所有对 PDF.js 的直接调用都集中在本模块，上层只经 `BookDocument` 窄接口交互。详见 `pdf/CODEMAP.md`。
- `markdown/`：Markdown 阅读子模块。`markdownParser.ts` 用 `marked` 渲染并经 `sanitizeHtmlFragment` 清洗、按一级标题分段并提取来源元数据；`markdownInspector.ts` 的 `inspectMarkdown` 做导入检查与标题/文件名兜底；`markdownEpub.ts` 把已清洗章节组装成最小 stored 内存 EPUB；`markdownBookDocument.ts` 的 `MarkdownBookDocument` 复用 `EpubBookDocument` 的 Foliate 宿主完成渲染。所有对 `marked`、内存 EPUB 与 Foliate 渲染的直接调用都集中在本模块。详见 `markdown/CODEMAP.md`。

## 依赖其它文件夹（树）

`domain/reader` 只从 `domain/library/epub/zip.ts` 复用有界 ZIP 读取器；运行时经 `foliate-js` 依赖渲染，原生预取只通过本目录的 typed 协议进入；`derivedToc.ts` 只消费章节文本并产出非权威临时目录，不回写 Foliate 原生 TOC 或原书。`domain/annotation/textAnchor.ts` 复用本目录的 `epubCfi.ts` 做同 spine 判断，不反向依赖渲染器实现。

## 被谁依赖（树）

```
domain/reader/
├── domain/workspace/     ReadingLocation 与 NavigationHistory 进入 WorkspaceState 的阅读视图
├── domain/annotation/    textAnchor 复用 epubCfi 的同 spine CFI 规则
└── workbench/
    ├── readerCommands.ts 创建 EpubBookDocument/PdfBookDocument/MarkdownBookDocument 并执行打开/翻页/跳转/关闭与历史接线
    ├── readerRuntime.ts  持有活 BookDocument 对象
    └── workspaceStore.ts 用 navigationHistory 管理视图历史
```

## 依赖方向

`domain/reader` 是阅读语义的深模块：把具体渲染器与清洗逻辑隔离在内部，通过 `BookDocument`、`ReadingLocation` 与 `NavigationHistory` 向上层提供窄接口。外部模块不得直接操作 Foliate View。
