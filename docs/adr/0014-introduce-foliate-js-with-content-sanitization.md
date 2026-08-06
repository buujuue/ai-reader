---
status: accepted
---

# 引入 foliate-js 并自带内容清洗打开 EPUB

## 背景

第 3 个切片需要让用户从书库打开托管 EPUB、翻页，并在重启后恢复标签与阅读位置。阅读内容一律视为不可信（ADR-0010）。

## 决策

- 经 npm 引入上游 `foliate-js@1.0.1`（MIT），通过 `foliate-view` 自定义元素渲染 EPUB。所有对具体渲染器的直接调用都集中在 `domain/reader/foliateViewHost.ts`；上层只经 `BookDocument` 窄接口交互（落实 ADR-0004）。
- `BookDocument` 暴露元数据、打开、位置读写、下一页/上一页、位置订阅与关闭；`EpubBookDocument` 是 EPUB 实现。
- 阅读位置用可序列化的 `ReadingLocation`（EPUB 为 CFI）表达，进入 `WorkspaceState.editorGroups[].views[].location`，随工作区持久化。
- 自带上游 `Loader.allowScript = false`（不起脚本）；另外在内容进入渲染器前用 `domain/reader/sanitizer.ts` 清洗 XHTML，移除 script、iframe、object、embed、frame、base、form、事件处理器属性与危险 URL（含 javascript:、vbscript:、data: 非图片），落实 ADR-0010。不提供“信任此书”开关。
  - 接线方式：foliate 的 Loader 在 `book.transformTarget` 上派发 `data` 事件，`foliateViewHost.ts` 在该事件改写 XHTML 内容后再交给渲染器；并监听 `external-link` 事件取消默认行为，阻止阅读帧导航到远程资源。
- 阅读位置高频写入由 `ThrottledPositionPersister` 节流合并，关闭视图或应用卸载时强制 flush。

## 取舍

- 采用 npm 上游 foliate-js 而非 Readest 分支：当前切片只需 EPUB 渲染与既有脚本禁用；Readest 分支的 PDF/跨端加固与构建体积在后续切片按需通过 ADR 引入。许可与来源登记见 `docs/legal/third-party.md`。
- 清洗器用 DOMParser/XMLSerializer 原地清理，不引入 DOMPurify 依赖；XHTML 解析失败时回退 HTML 解析，任何情况下不把未清洗内容直接交给渲染器。