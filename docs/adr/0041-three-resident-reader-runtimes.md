# ADR-0041：为 ReadingView 建立三 resident Runtime 常驻契约

- 状态：已接受
- 日期：2026-08-31
- 关联工单：#60（容量决策）；#62（实现与总验收）
- 替代范围：替代 ADR-0040 中 Reader Runtime 的 resident 容量、挂起容量和跨格式性能验收口径；保留 ADR-0040 的缓存键、`active/suspended/evicted/closed` 生命周期、失效规则、Workspace State 可序列化边界、每组一个活动渲染器和全局最多两个活动渲染器。PDF 挂起 Runtime 的首帧 DOM/Canvas/文本层复用与邻页延迟恢复由 ADR-0042 进一步细化。
- 后续状态：桌面 suspended Canvas/解码页聚合上限和 Issue #63 压力验收口径已由 ADR-0043 替代；平板预算及其余生命周期决定继续有效。

## 背景

ADR-0040 已经让 EPUB、Markdown 和 PDF 在 A→B→A 时可以复用已完成的 Reader Runtime，但桌面和平板的挂起槽位只有一个。用户依次打开三份材料时，第三份材料会让最早离开的 Runtime 被淘汰，无法兑现“仍打开的三份材料可以直接回切”的体验。

Readest 的用户体验表明，保留已解析的 `BookDocument` 和 renderer 能减少回切等待；但 Readest 的 `bookDataStore` 按材料共享 `bookDoc`，不适合作为 AI Reader 的跨 Editor Group 状态模型。AI Reader 需要把 resident 上限、资源预算和每个 ReadingView 的隔离同时写成可执行契约。

## 决策

### Resident 容量与所有权

`resident Runtime` 指仍由 `ReaderRuntime` 或 `ReaderRuntimeCache` 持有、可以在不重新打开来源的情况下尝试恢复的 ReadingView Runtime。容量按 Runtime 实例计数，不按材料计数：同一材料在两个 Editor Group 中打开时，两个 `viewId` 各占一个 resident 名额，也绝不共享可变 renderer。

每个配置都必须满足以下硬上限：

| 项目 | 桌面 | 平板 |
| --- | ---: | ---: |
| resident Runtime 总数 | 3 | 3 |
| active Runtime 总数 | 2 | 2 |
| suspended Runtime 数量上限 | 2 | 2 |

这三个数字不是相加关系。resident 是 active 与 suspended 的总和，因此有效组合是：一个 active 最多带两个 suspended；两个 active 最多带一个 suspended。工作区最多两个 Editor Group 负责 active 上限，缓存深模块负责 resident 与 suspended 上限。

缓存只能持有已完成首次打开且格式为 EPUB、Markdown 或 PDF 的对象。登记新的 active Runtime 或挂起新的 Runtime 使 resident 容量超限时，只能按最近使用时间淘汰 suspended 对象；active 对象不会被缓存静默淘汰。被淘汰的对象由 `ReaderRuntime` 唯一调用 `close()`，缓存不直接关闭活对象。

### 切换与恢复顺序

`reader.activateView` 在同一串行转换中执行以下顺序：

1. 对当前 active View flush 最新可序列化位置；失败时保留原 active View、输入接线和 Workspace 活动关系。
2. 清理当前 View 的输入、搜索任务、Selection、焦点、位置监听器和临时覆盖层；PDF 同时断开观察器并暂停范围调度。
3. 如果目标 View 的缓存键精确命中，先把目标从 suspended 提升为 active，再挂起原 View。这样 resident 容量收缩时不会先把正要回切的目标按 LRU 淘汰。
4. 命中后只调用原 `BookDocument.attach`，不重新打开 `ManagedFileSource`，不创建 `BookDocument` 或底层 renderer；恢复位置以已经 flush 的 Workspace 位置为权威。PDF 在快照条件满足时同步复挂当前页首帧，邻页预取延后；具体规则见 ADR-0042。
5. 未命中、键失配、失效、容量不足或 attach 失败时，关闭旧对象并按当前 Workspace State 安全重建。重建失败保留标签和中文错误状态，不猜测位置。

普通切换只改变 Runtime 生命周期，不改变 Workspace State 的可序列化边界。关闭标签、应用退出、材料版本替换、重新关联、永久清理和 Markdown 正式内容/恢复快照变化都走关闭或按材料全量失效路径。

### active 与 suspended 对象规则

| 内容 | active | suspended |
| --- | --- | --- |
| 当前页面/位置 | 保留并接受用户输入；最新位置可节流写入 | 保留已 flush 的位置、视口、导航历史和格式状态；不得用迟到事件覆盖快照 |
| EPUB/Markdown renderer | 挂载在可见容器，保留活动监听器 | 保留已打开的 `BookDocument` 和可复用 renderer；摘下可见容器，不保留输入接线 |
| PDF 页面 | 由 `PdfRenderer` 管理视口窗口、Canvas、文本层和解码页 | 只保留 PDF.js 文档、当前页的预算内 Canvas/解码页；释放远离当前页的页面，断开观察器并暂停范围读取 |
| 输入/搜索/Selection/焦点 | 仅当前 active View 持有 | 全部清理；搜索任务取消，Selection 清空，焦点失效，不能在后台响应输入 |
| 观察器/后台调度 | 可运行 | 全部断开/暂停；PDF 在途范围读取必须归零，否则拒绝缓存并关闭重建 |
| 临时覆盖层 | 仅当前可见 View 使用 | 不保留会响应事件的临时覆盖接线；可随文档重新绘制的材料批注数据仍由材料级领域状态负责 |
| Markdown 编辑会话 | CodeMirror 源码模式独占可见区域；Foliate 不同时占有可见区域 | 共享 `MarkdownDocumentSession` 仍按材料存在，但缓冲区、正式保存、放弃或恢复快照变化必须先失效该材料全部 Runtime，再按最新会话文本重建 |

PDF `detach` 必须等待范围传输收敛；超时即拒绝 suspended 准入并关闭重建，不留下 PDF.js 永久等待。PDF 回切可以复用 PDF.js 文档和当前页结果；满足 ADR-0042 快照条件时首帧直接复挂页面 DOM，否则走安全重排/重建路径。无论哪条路径，首次可交互前都不得重新取得或光栅化已保留的可见页。

### 桌面与平板资源硬预算

下表约束所有 suspended Runtime 的单项与聚合资源。每个条目先满足单项上限，所有 suspended 条目再满足聚合上限；任何超限都通过 LRU 淘汰最旧 suspended 条目，不能突破预算。

| 资源 | 桌面 | 平板 |
| --- | ---: | ---: |
| suspended iframe 总数 | 4 | 2 |
| suspended Canvas 总数 | 2（每个 PDF 仍只保留当前页） | 1（PDF 当前页） |
| suspended 解码页总数 | 2（每个 PDF 仍只保留当前页） | 1（PDF 当前页） |
| suspended 在途范围读取 | 0 | 0 |
| suspended 范围缓存总量 | 16 MiB | 8 MiB |
| suspended 估算资源总量 | 16 MiB | 8 MiB |

active Runtime 的两个可见组仍由各格式 renderer 的既有窗口、并发和 Canvas 预算约束。缓存预算只描述挂起对象，不把活对象塞进 Workspace State；`ReaderRuntimeResourceUsage` 是诊断快照，不是持久化字段。

### 与 Readest 的继承与取舍

已检查本机 Readest 参考仓库中的以下实现：

- `apps/readest-app/src/store/bookDataStore.ts` 的 `BookData` 按材料保留 `file` 与 `bookDoc`，以及 `apps/readest-app/src/store/readerStore.ts` 对既有 `bookDoc` 的复用。AI Reader 继承“已解析文档可复用”的回切体验，但按 `viewId` 隔离 Runtime，避免两个 Editor Group 共享可变 renderer、位置或输入焦点。
- `packages/foliate-js/fixed-layout.js` 的预加载 spread 缓存和 `#cleanupPreloadCache` 的访问时间淘汰。AI Reader 继承局部预取和 LRU 的资源意识，但把容量提升限制为三份 ReadingView Runtime，并由 `ReaderRuntimeCache` 统一管理 resident；不会把 Readest 的应用层书籍状态或无限常驻带入本产品。
- `packages/foliate-js/pdf.js` 的 PDF.js 文档加载、页面取得和页面渲染路径。AI Reader 继续把 PDF.js 隔离在 `domain/reader/pdf/`，并由自己的 `PdfRenderer` 管理当前页窗口、范围读取暂停和 Canvas 预算，不直接移植 Readest 的 PDF 应用层实现。

本工单没有直接复制 Readest 代码，因此不新增第三方代码片段；参考来源、许可证和既有独立重写说明仍登记在 `docs/legal/third-party.md`。

## 验收

`apps/reader/scripts/verify-reader-runtime-cache.mjs` 通过真实应用的 `library.openBook` 与 `reader.activateView` Command，至少测量三轮并执行：

- EPUB→Markdown→PDF→EPUB：确认三份按 `viewId` 隔离的 resident Runtime 在回切前后均存在，记录每份材料首次可见、首次可交互时间。
- 缓存命中：记录命中、来源打开、BookDocument 身份、Foliate renderer、PDF.js 文档、页面取得、PDF 光栅化、范围读取和可获得的堆内存；EPUB 回切命中不能新增这些对象或读取，PDF 在首次可交互前不能新增页面取得或光栅化。
- 既有六组格式 pair、PDF A→B→A→B→A、Markdown 源码模式/正式保存/恢复快照/重启、双 Editor Group 与关闭清理继续作为回归门禁。

决策基线曾使用 `reader-runtime-cache.v4` 关联 Issue #60；Issue #62 的实现总验收升级为 `reader-runtime-cache.v5`，继承 Issue #61/#60/#57，并增加单组/双组三材料轮换、隐藏 Editor Group 挂起和按 View 计数的 LRU 证据。PDF 首帧节点复用与首帧前无页面工作由 Issue #61 的门禁补充。执行命令：

```powershell
pnpm --dir apps/reader test:reader-runtime-cache
pnpm --dir apps/reader test:reading-performance
```

浏览器设备模拟只能补充布局反馈，不能替代 Windows Tauri、iPadOS 或 Android 平板的原生证据。

## 后果

- 用户在三份材料之间执行 EPUB→Markdown→PDF→EPUB 时，预算内回切可以直接复用离开前 Runtime；第四份材料才会触发 suspended LRU 淘汰。
- 两个 Editor Group 仍最多拥有两个 active Runtime；同材料跨组仍保留两个独立 ReadingView 实例。
- resident 容量增加会延长活对象生命周期，因此所有材料失效、退出和异常恢复路径必须继续经过 Runtime 所有者关闭对象；任何无法证明一致性的对象宁可重建。
- 平板与桌面沿用不同资源硬预算，真实三视图基线只证明当前机器和浏览器的相对回切性能，不形成固定毫秒承诺。
