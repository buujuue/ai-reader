# apps/reader/scripts — 应用级验证脚本

不属于 `src/` 前端源码,仅包含需要在真实浏览器/进程中运行的验证脚本。

| 脚本 | 用途 | 运行 |
| --- | --- | --- |
| `verify-real-render.mjs` | 真实浏览器渲染冒烟测试:启动 Vite → 用系统 Chrome(puppeteer-core)打开应用 → 导入示例书 → 断言 foliate 真实渲染出阅读位置(CFI)且容器/渲染器尺寸非零。 | `pnpm test:real-render` |
| `verify-epub-p0.mjs` | 真实浏览器 EPUB P0 矩阵:直接创建 foliate-view,验证 EPUB 2/NCX、EPUB 3/NAV、目录 href/页内链接、位置反馈、前后章节、关闭后 CFI 恢复、固定版式、RTL/竖排、图片/SVG、脚注、混淆字体与 MathML。 | `pnpm test:real-epub-p0` |
| `verify-reading-performance.mjs` | 大型 EPUB/PDF 统一 Source 性能验收:真实 Chrome 覆盖 EPUB 首屏/章节切换/资源加载与 PDF 文档信息/首屏/翻页,记录首次可见内容耗时、阶段累计范围字节、最大范围和读取峰值。 | `pnpm test:reading-performance` |
| `verify-pdfjs-wasm-assets.mjs` | 构建后校验 PDF.js Worker 引用的 WASM/JS 解码资源均已输出,防止 JBIG2 等扫描 PDF 解码器漏包。 | `pnpm verify:pdfjs-wasm` |
| `verify-search.mjs` | 真实浏览器搜索验证测试:打开示例书 → Ctrl+F → 输入关键词 → 断言异步产生命中、正文渲染命中高亮、上一项/下一项跳转改变位置、关闭搜索清理高亮与结果。 | `pnpm test:real-search` |
| `verify-annotations.mjs` | 真实浏览器批注验证测试:打开示例书 → 选中正文 → 弹出「高亮」工具栏 → 创建高亮并断言 overlayer 绘制覆盖层、锚点含 CFI/引文/前后文/恢复状态,再 reload 断言批注从持久化恢复并重新绘制。 | `pnpm test:real-annotations` |

## 约定

- 依赖 `puppeteer-core`(devDependency),不下载浏览器,连接系统 Chrome;可用 `CHROME_PATH` 环境变量指定。
- 截图产物写入 `scripts/artifacts/`,已由仓库根 `.gitignore` 排除,不入库。
- 该脚本是对 jsdom 单元测试的补充:jsdom 无法运行 foliate 的真实分页布局,因此用真实浏览器验证"EPUB 确实能打开并渲染"这一端到端 Seam。
