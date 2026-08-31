# ADR-0043：以分档资源预算验收三材料轮换与安全退化

- 状态：已接受
- 日期：2026-09-01
- 关联工单：#63
- 继承决策：ADR-0041、ADR-0042
- 替代范围：替代 ADR-0041 中桌面 suspended Canvas/解码页总数为 1 的限制，并升级 Reader Runtime 总验收口径；平板预算、resident/active/suspended 数量、缓存键与生命周期不变。

## 背景

三个 EPUB 或 Markdown Runtime 可以在既有预算内直接轮换；三份 PDF 要同时满足 A→B→C→A 三项命中和首帧不重新取得/光栅化当前页，则一个 active PDF 之外还必须允许两份 suspended PDF 各保留一个当前页结果。旧桌面聚合上限只有一个 Canvas/解码页，因此无法同时兑现三 PDF 无空白回切与资源硬边界。

Readest 证明了保留已解析文档、页面结果和局部 LRU 能改善回切，但它没有 AI Reader 按 ReadingView 隔离的三 resident 契约。这里继续使用本项目的 `ReaderRuntimeCache`、Workspace State 与格式边界，不引入按材料共享 renderer。

## 决策

### 分档预算

resident 总数仍为 3，active 最多 2，suspended 最多 2。桌面 suspended Canvas 与解码页聚合上限从 1 提升到 2；平板继续为 1。其它硬预算不变：桌面 suspended 估算资源与范围缓存各 16 MiB，平板各 8 MiB，在途范围读取均为 0。

每个 PDF suspended Runtime 仍只能保留自己的当前页一个 Canvas/解码页。桌面允许两个不同 ReadingView 的当前页同时存在，但必须继续满足聚合字节预算；单项超限或累计超限仍按 LRU 淘汰 suspended，绝不淘汰 active。平板三 PDF 轮换若超过一个 Canvas或 8 MiB 聚合预算，必须明确 miss 并安全冷重建，不能突破预算冒充命中。

### 诊断与关闭所有权

`ReaderRuntimeCache.getDiagnostics()` 除计数与生命周期转换外，结构化记录 `lookupMisses` 和 `admissionRejections`。拒绝原因区分不支持格式、未就绪和资源预算；查找 miss 区分不存在与键失配。诊断列表与生命周期记录使用相同有界长度，不形成新的内存增长点。

LRU、键失配、材料失效和清理仍只返回对象，由 Reader Runtime 所有者唯一执行 `close()`。第四项进入后，报告必须证明最旧 suspended 只关闭一次；重新激活被淘汰 View 时从 Workspace State 冷重建并恢复位置。

### 验收证据

`pnpm --dir apps/reader test:reader-runtime-cache` 输出脱敏的 `reader-runtime-cache.v6`：

- EPUB、Markdown、PDF 各自执行三材料 A→B→C→A→B→C，三项命中均不重开来源、BookDocument 或 renderer；
- 混合格式与两个 Editor Group 继续验证位置、焦点、输入目标、搜索、材料级批注、Markdown 共享会话和主要阅读材料隔离；
- PDF 三材料与连续多轮回切在首次可交互前不新增当前页取得或光栅化，并验证当前页 DOM、Canvas、文本层与覆盖层身份；
- 第四项、单项超限和累计超限记录 LRU、结构化 miss/拒绝、关闭一次、冷重建、位置恢复、资源快照以及中位数/P95；
- 成功和失败报告都在 `finally` 清理 Runtime、浏览器和 Vite，且不记录本地路径或正文。

600 页以上 PDF、范围读取、滚动窗口、峰值内存与 Windows `managed-range` 仍由 `pnpm --dir apps/reader test:reading-performance` 验证。浏览器结果只证明共享逻辑；Windows Tauri 与 macOS/iPadOS/Android 原生证据按平台冒烟文档独立记录。

## 后果

- 桌面可以让三份预算内 PDF 都直接回到保留首帧，同时继续由 16 MiB 聚合字节预算兜底。
- 平板保持更严格的一个 suspended PDF 当前页上限；内存不足时用户看到可诊断冷重建，而不是后台继续持有 Canvas。
- 资源预算成为平台分档契约，文档和报告必须同时写明命中与退化，不能用桌面 Chrome 结果替代原生平板证据。

## 参考与许可

继续参考 Readest `apps/readest-app/src/store/bookDataStore.ts`、`apps/readest-app/src/store/readerStore.ts`、`packages/foliate-js/fixed-layout.js` 与 `packages/foliate-js/pdf.js` 的文档复用、页面结果和局部 LRU 行为。本工单没有直接复制 Readest 代码，不新增第三方许可义务。
