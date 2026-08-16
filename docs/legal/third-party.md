# 第三方许可与来源

AI Reader 本身以 AGPL-3.0 发布(见根目录 `LICENSE`)。本文件记录当前底座实际使用的第三方组件及后续切片计划复用的关键来源,确保署名与许可义务清晰。

## 当前底座使用的组件

### JavaScript / TypeScript

| 组件 | 版本策略 | 许可证 | 用途 |
| --- | --- | --- | --- |
| React / react-dom | ^19 | MIT | 工作台界面 |
| Zustand | ^5 | MIT | Workspace Store |
| lucide-react | ^1 | ISC | 活动栏图标 |
| Vite / @vitejs/plugin-react | ^7 / ^5 | MIT | 构建与开发服务器 |
| TypeScript | ~5.9 | Apache-2.0 | 类型系统 |
| Vitest / jsdom / Testing Library | ^4 / ^30 / ^16 | MIT 等 | 前端测试 |
| Tailwind CSS | ^4 | MIT | 样式 |
| @tauri-apps/api / @tauri-apps/cli | ^2 | MIT / Apache-2.0 | Tauri IPC 与工具链 |
| @tauri-apps/plugin-dialog | ^2 | MIT / Apache-2.0 | 托管导入的系统文件选择器 |
| @tauri-apps/plugin-opener | ^2 | MIT / Apache-2.0 | 外部链接交给系统浏览器 |
| foliate-js | ^1.0.1 | MIT | EPUB 渲染内核;《view.js》《epub.js》《paginator.js》等源自 [johnfactotum/foliate-js](https://github.com/johnfactotum/foliate-js) |
| pdfjs-dist | ^5.7.284 | Apache-2.0 | PDF 固定版式阅读内核（工单 #14 引入） |
| marked | ^18 | MIT | Markdown 渲染内核（工单 #17 引入） |
| codemirror | ^6 | MIT | Markdown 源码编辑器内核（工单 #18 引入） |
| @codemirror/lang-markdown | ^6 | MIT | CodeMirror 的 Markdown 语法高亮 |
| @codemirror/view | ^6 | MIT | CodeMirror 视图层与 keymap |

精确版本以 `pnpm-lock.yaml` 为准。

### Rust

| crate | 版本策略 | 许可证 | 用途 |
| --- | --- | --- | --- |
| tauri / tauri-build | ^2 | MIT / Apache-2.0 | 应用框架 |
| tauri-plugin-dialog | ^2 | MIT / Apache-2.0 | 系统文件选择器 |
| tauri-plugin-opener | ^2 | MIT / Apache-2.0 | 外部链接交给系统浏览器 |
| rusqlite(bundled SQLite) | ^0.40 | MIT | SQLite 绑定;SQLite 本身为公有领域(public domain) |
| serde / serde_json | ^1 | MIT / Apache-2.0 | typed 命令序列化 |
| thiserror | ^2 | MIT / Apache-2.0 | 错误类型 |
| sha2 | ^0.10 | MIT / Apache-2.0 | 完整内容指纹(SHA-256) |
| uuid | ^1 | MIT / Apache-2.0 | 稳定 BookId 与暂存标识 |
| base64 | ^0.22 | MIT / Apache-2.0 | 暂存文件字节传输编码 |
| zip | ^2 | MIT | EPUB 原生路径的 ZIP 中央目录与受限条目预取 |
| quick-xml | ^0.41 | MIT | EPUB 原生路径读取 container/OPF/NAV/NCX 的 XML 结构 |
| percent-encoding | ^2 | MIT/Apache-2.0 | 与 foliate-js 对齐包内 href 的百分号解码 |

精确版本以 `Cargo.lock` 为准。

## 计划复用的阅读内核

后续切片将按 `docs/adr/0001` 与规格的选择性复用原则引入:

- **PDF.js**:Apache-2.0 许可。引入时保留版权声明与 NOTICE 要求。

引入任一组件的切片必须同时提交其许可文本与来源记录,不先行创建空包。

## foliate-js 引入记录

- 已于第 3 个切片(安全打开 EPUB 并重启续读)经 npm 引入上游 `foliate-js@1.0.1`(MIT),来源 [johnfactotum/foliate-js](https://github.com/johnfactotum/foliate-js)。
- 使用范围:通过 `foliate-view` 自定义元素渲染 EPUB;所有直接调用集中在 `apps/reader/src/domain/reader/foliateViewHost.ts`,上层只经 `BookDocument` 窄接口交互。
- 安全边界:`Loader.allowScript` 默认关闭(参考 Readest 分支的既有加固);`domain/reader/sanitizer.ts` 在内容进入渲染器前统一清洗 XHTML/HTML、SVG、CSS 和脚本 MIME，移除脚本、iframe、对象嵌入、音视频媒体、危险 URL 与可执行 CSS，非核心资源失败时回退到清洗后的静态章节，落实 ADR-0010。
- upstream 许可文本随 npm 包保留在 `node_modules/.pnpm/foliate-js@1.0.1/node_modules/foliate-js/LICENSE`。

## EPUB 原生预取来源记录

- 本切片的 ZIP/OPF/NAV/NCX 机械预取模式参考并选择性移植 Readest `apps/readest-app/src-tauri/src/epub_parser.rs` 与 `apps/readest-app/src/utils/tauriEpubBridge.ts`；来源仓库 [readest/readest](https://github.com/readest/readest) 以 AGPL-3.0 发布，署名要求是保留 Readest 项目名称、仓库链接和 AGPL-3.0 许可说明；若来源文件含版权/许可头，移植时一并保留。移植内容仅限路径解析、条目读取、尺寸表和 typed bridge 形状，AI Reader 保持 foliate-js 为唯一 EPUB 语义来源，不复制 Readest 应用层阅读状态。
- Rust 侧新增 `zip`、`quick-xml` 与 `percent-encoding` 仅服务上述机械预取；其许可证与精确版本以 `Cargo.lock` 为准。

## pdfjs-dist 引入记录

- 已于第 6 个切片(PDF 固定版式阅读, 工单 #14)经 npm 引入上游 `pdfjs-dist@5.7.284`(Apache-2.0), 来源 [mozilla/pdf.js](https://github.com/mozilla/pdf.js)。
- 使用范围:范围读取、解码、渲染、文本层与封面提取;所有直接调用集中在 `apps/reader/src/domain/reader/pdf/` 子模块, 上层只经 `PdfBookDocument`(实现 `BookDocument`)窄接口交互。
- 安全边界:加载时关闭 `isEvalSupported`, 不执行 PDF 内脚本;渲染内容不触发远程资源加载。
- upstream 许可文本随 npm 包保留在 `node_modules/.pnpm/pdfjs-dist@5.7.284/node_modules/pdfjs-dist/LICENSE`。

## marked 引入记录

- 已于第 7 个切片(Markdown 安全导入并阅读, 工单 #17)经 npm 引入上游 `marked@18`(MIT), 来源 [markedjs/marked](https://github.com/markedjs/marked)。
- 使用范围:把 Markdown 源渲染为 HTML,再经 `sanitizeHtmlFragment` 清洗并按一级标题分段;所有直接调用集中在 `apps/reader/src/domain/reader/markdown/` 子模块,上层只经 `MarkdownBookDocument`(实现 `BookDocument`)窄接口交互。
- 安全边界:Markdown 渲染结果视为不可信输入,`domain/reader/sanitizer.ts` 的 `sanitizeHtmlFragment` 在进入任何渲染器前移除脚本、iframe、对象嵌入、事件处理器与危险 URL,落实 ADR-0010。
- upstream 许可文本随 npm 包保留在 `node_modules/.pnpm/marked@*/node_modules/marked/LICENSE.md`。

## CodeMirror 引入记录

- 已于第 8 个切片(共享编辑 Markdown 并正式保存, 工单 #18)经 npm 引入上游 `codemirror@6`(MIT), 来源 [codemirror/codemirror.next](https://github.com/codemirror/codemirror.next), 随附 `@codemirror/lang-markdown` 与 `@codemirror/view`。
- 使用范围:Markdown 源码模式编辑器, 提供高亮、撤销重做与查找替换(basicSetup);所有直接调用集中在 `apps/reader/src/components/MarkdownSourceEditor.tsx`, 仅在首次进入源码模式时懒加载。
- 编辑内容读写统一的 `MarkdownDocumentSession` 共享缓冲区;保存由稳定 Command 触发, 经 Rust 原子写托管文件, 上层不直接写文件。
- upstream 许可文本随 npm 包保留在 `node_modules/.pnpm/codemirror@*/node_modules/codemirror/LICENSE`。

## 借鉴说明

本项目架构与阅读行为大量参考 [readest/readest](https://github.com/readest/readest)(AGPL-3.0),但为独立重写,不复制其应用层代码、状态模型或用户数据格式。若未来直接移植任何 Readest 代码片段,将逐处登记来源、许可与署名。

已借鉴的实现模式:

- 批量文件选择:参照 Readest `apps/readest-app/src/services/nativeAppService.ts` 的 `selectFiles`,对 Tauri dialog 使用 `open({ multiple: true })` 一次选择多份文件;本项目的 `FilePicker.pickEpubs()` 与 `filePicker.ts` 仅复用该模式,不复制其路径作用域、SAF 解析等外围逻辑。
- 当前材料搜索:搜索能力直接复用已引入的 `foliate-js` 内置 `view.search()`/`clearSearch()`(见 `domain/reader/foliateViewHost.ts` 的归一化),不复制其应用层搜索栏。增量进度、取消与命中跳转的结果编排模式参考 Readest `apps/readest-app/src/app/reader/components/sidebar/SearchBar.tsx`,但本项目为独立的最小实现(见 `workbench/searchRunner.ts` 与 `components/SearchBar.tsx`),不复制其搜索缓存、历史、正则/邻近词等多模式外围逻辑。
- 阅读排版:由全局默认、材料级覆盖与阅读视图三层排版数据模型及经渲染器注入 CSS 的思路,参考 Readest `apps/readest-app/src/utils/style.ts` 的 `getStyles()`。本项目为独立的最小实现(`domain/reader/typography.ts` 的 `buildTypographyCss` + `foliateViewHost.ts` 的 `applyTypography`),字体与颜色使用固定映射(衬线/无衬线/系统、浅色/护眼/深色),不复制其主题管理、字体列表、段落缩进等外围逻辑。
- PDF 阅读内核:范围读取并发上限、过期渲染取消、画布内存预算与滚动窗口化思路,参考 Readest 的 `packages/foliate-js/pdf.js` 与 `packages/foliate-js/src/foliate/view/pdf.js`。本项目为独立的最小实现(`domain/reader/pdf/` 的 `pdfRangeTransport.ts`、`pdfPageRenderer.ts`、`pdfRenderer.ts`),不复制其应用层 PDF 工具栏、页面缩略图、双页/连续滚动等外围逻辑。
- PDF 文本层定位(工单 #15):文本 span 的定位算法参考 pdf.js 的 `TextLayer`(Apache-2.0,内置在 `pdfjs-dist`,见其 `#appendText`/`#layout` 的 transform→显示坐标换算)。本项目为独立的最小实现 `domain/reader/pdf/pdfTextLayer.ts`,只处理水平、未旋转的常规情形,不复制其字体度量、离线画布、RTL/旋转等外围逻辑。
