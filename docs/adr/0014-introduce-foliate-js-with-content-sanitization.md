---
status: accepted
---

# 引入 foliate-js 并自带内容清洗打开 EPUB

## 背景

第 3 个切片需要让用户从书库打开托管 EPUB、翻页，并在重启后恢复标签与阅读位置。阅读内容一律视为不可信（ADR-0010）。

## 决策

- 经 npm 引入上游 `foliate-js@1.0.1`（MIT），通过 `foliate-view` 自定义元素渲染 EPUB。所有对具体渲染器的直接调用都集中在 `domain/reader/foliateViewHost.ts`；上层只经 `BookDocument` 窄接口交互（落实 ADR-0004）。
- `BookDocument` 暴露元数据、打开、位置读写、目录读取、href 导航、书内/外部链接事件、下一页/上一页、位置订阅与关闭；`EpubBookDocument` 是 EPUB 实现。
- 阅读位置用可序列化的 `ReadingLocation`（EPUB 为 CFI）表达，进入 `WorkspaceState.editorGroups[].views[].location`，随工作区持久化。
- 每个阅读视图维护可序列化的导航历史（`readerViewState.history`）：显式跳转（目录、书内链接、搜索结果、批注）压入节点，普通翻页/滚动仅替换当前节点，最多 50 个节点，随工作区持久化并在重启后恢复。
- 书内点击的 `link`/`external-link` 事件由宿主 `preventDefault` 阻止默认导航：书内链接交给统一导航命令（压入历史），外部链接先展示目标、确认后经统一 Command 由系统浏览器打开，阅读 WebView 不导航到外部站点（ADR-0010）。
- 自带上游 `Loader.allowScript = false`（不起脚本）；另外在内容进入渲染器前用 `domain/reader/sanitizer.ts` 的 `sanitizeEpubResource` 清洗 XHTML/HTML、SVG 与 CSS，移除 script、iframe、object、embed、frame、base、form、audio、video、source、track、portal、事件处理器属性、危险 URL 和可执行 CSS；已知脚本 MIME 清洗为无内容，异常按失效安全策略丢弃资源，落实 ADR-0010。不提供“信任此书”开关。
  - 接线方式：`foliateViewHost.ts` 先用 `makeBook` 构造 EPUB，再在 `book.transformTarget` 的 `data` 事件上注册清洗器，然后才交给 `foliate-view` 创建 renderer，确保首章和后续章节都经过同一边界；并监听 `external-link` 事件取消默认行为，阻止阅读帧导航到远程资源。若包内非核心资源加载失败，章节 `load()` 回退到清洗后的静态正文 URL；章节文本本身不可读时仍向上抛出错误。
- 阅读位置高频写入由 `ThrottledPositionPersister` 节流合并，关闭视图或应用卸载时强制 flush。

## 取舍

- 采用 npm 上游 foliate-js 而非 Readest 分支：当前切片只需 EPUB 渲染与既有脚本禁用；Readest 分支的 PDF/跨端加固与构建体积在后续切片按需通过 ADR 引入。许可与来源登记见 `docs/legal/third-party.md`。
- 清洗器用 DOMParser/XMLSerializer 原地清理，不引入 DOMPurify 依赖；XHTML 解析失败时回退 HTML 解析，任何情况下不把未清洗内容直接交给渲染器。
