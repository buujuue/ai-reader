# ADR-0030：PDF 检查与阅读共享 ManagedFileSource 范围来源

## 状态

已接受（工单 #35、#43）。

## 背景

工单 #33 已提供按稳定 MaterialId 打开的 `ManagedFileSource`，但 PDF 打开曾先通过检查器创建并销毁一份 PDF.js 文档，再让 `PdfBookDocument` 为正式阅读创建第二份文档。大型 PDF 因此在检查和正式阅读之间重复解析，可能在 128 KiB LRU 淘汰后再次读取接近整份文件，首屏也被不必要的检查阶段阻塞。

`pdfRangeTransport.ts` 已有并发队列，但此前没有接入 PDF.js 的实际 `getDocument` 调用。

## 决策

- 导入阶段由 `PdfInspector.inspectPdf` 负责格式校验、来源元数据和首页来源封面；已导入材料的阅读 Command 只从 `ReadingMaterial` 读取有效标题/作者/语言，并由 `ImportRepository.openManagedFileSource(materialId)` 获取一次来源。
- `PdfBookDocument` 只在 `ReadingView` 挂载阶段创建 PDF.js 文档；从打开 Command 到首屏，每个新建活动 Runtime 只调用一次 `getDocument`。切换标签、重启恢复和双 Editor Group 各自遵守同一边界。
- `PdfInspector.inspectPdf` 与 `PdfBookDocument` 的范围来源契约保持一致，但检查器不再属于已导入材料的阅读打开路径。
- PDF.js 只通过 `PDFDataRangeTransport` 获取内容，禁止再传入完整 `data`。`disableStream` 与 `disableAutoFetch` 均开启，文档信息、页面尺寸、首屏和后续页面由 PDF.js 按需触发范围请求。
- 范围传输继续使用最多 6 个在途读取，并在 `ManagedFileSource` 层复用 128 KiB 分块 LRU。阅读阶段不再先销毁检查文档，因此 Source 缓存只服务当前 Runtime 的单轮 PDF.js 解析；导入阶段检查仍在提交前独立运行。
- 传输销毁时清空排队范围并忽略已在途读取的结果；范围参数越界立即拒绝。单段底层读取失败不得提交伪数据，且必须释放并发槽让其它读取收敛；传输以带请求区间的领域错误通知打开/检查边界，禁止静默挂起或回退到全量读取。
- PDF 渲染窗口、已解码页面上限、缩放、位置恢复、过期页面渲染取消和 `PdfBookDocument.close` 的资源释放行为保持不变。
- 暂存导入阶段若已有 `Uint8Array`，只在进入检查器前包装为范围来源；这不改变导入阶段已有的暂存读取协议。托管材料的打开路径不得回退到全量读取。

## 取舍

PDF.js 的 `PDFDataRangeTransport` 没有公开的单次读取失败回调，因此传输层不伪造错误数据，而是以自有失败事件保留区间、取消后续队列并让打开/检查操作竞速失败事件；阅读打开将其转换为简体中文 `PdfOpenError`，并保留请求区间。PDF.js 结构错误与初始化错误也不依赖检查器才能分类。更细粒度的 AbortSignal 需要改变 `ManagedFileSource` 与 typed Repository 契约，本工单不扩大该边界。

Readest 的 `packages/foliate-js/pdf.js` 只作为范围队列和并发上限的行为参考；本实现保持 AI Reader 自己的 PDF.js 窄接口、ManagedFileSource 缓存和生命周期。
