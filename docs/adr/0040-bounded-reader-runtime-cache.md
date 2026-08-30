# ADR-0040：采用有界 Reader Runtime 缓存

- 状态：已接受
- 日期：2026-08-30
- 关联工单：#53
- 替代范围：替代 ADR-0004 与 ADR-0005 中“所有非活动 ReadingView 立即释放 Reader Runtime”的生命周期约束；保留其中关于 `BookDocument` 边界、Workspace State 可序列化、每个可见 Editor Group 最多一个活动渲染器和全局最多两个活动渲染器的决定。

## 背景

标签切换前需要 flush 阅读位置，但每次失活都关闭 Foliate View 会让 EPUB/Markdown 在 A→B→A 时重新解析内容、重建 iframe 和再次读取托管文件。Readest 的 `BookData` 会保留 BookDocument 与 Foliate View，这证明保留已解析对象可以改善回切；但 AI Reader 不能照搬其无限驻留的应用层状态，也不能让缓存对象进入持久化工作区。

## 决策

Reader Runtime 由 `readerRuntime.ts` 持有，`readerRuntimeCache.ts` 管理有限的活对象缓存。缓存按 ReadingView 身份保存，而不是按材料共享 renderer：同一材料跨 Editor Group 仍是两个独立 View。

### 生命周期与所有权

```text
active ──挂起前 flush/清理──> suspended ──LRU/失效──> evicted ──close──> terminal
  │                              │
  └────关闭标签/退出/版本替换─────┴──────────────────────────────> closed
```

| 状态 | 所有者 | 允许的对象 | 进入条件 | 离开语义 |
| --- | --- | --- | --- | --- |
| `active` | `ReaderRuntime` + 当前 `ReadingView` | 当前 Foliate View、iframe、加载完成的派生 DOM、活动监听器 | 当前组活动且挂载成功，最多两个 | 普通切换进入 `suspended`；关闭、版本变化或错误进入 `closed` |
| `suspended` | `ReaderRuntimeCache` + `ReaderRuntime` | 已完成的 EPUB/Markdown BookDocument、Foliate renderer、缓存 iframe 与范围块；不保留输入接线 | 首次打开完成，缓存键和资源均符合预算 | 精确键命中回到 `active`；预算、指纹/版本/算法变化进入 `evicted` |
| `evicted` | `ReaderRuntime` 清理流程 | 不再对用户可用的对象，仅作为一次性转换结果 | LRU 淘汰、缓存禁用或资源超限 | 调用唯一 `removeDocument` 并 `close()`，不回到缓存 |
| `closed` | 无 Runtime 所有权 | 无 Foliate View、DOM、加载任务或选择 | 关闭标签、应用退出、永久清理、版本迁移、打开失败 | 只能按当前 Workspace State 安全重建，不能复活旧对象 |

挂起属于 Runtime 生命周期，不改变 Workspace State。挂起前必须按顺序 flush 最新可序列化阅读位置、取消并清除搜索命中、移除输入/链接/位置监听器、清空内容文档 Selection、让活动元素失焦，并关闭临时覆盖层接线。任何位置 flush 失败都中止切换并保留原 `active` Runtime，避免丢失最后位置。

`EpubBookDocument.attach/detach` 只负责把已打开的 Foliate renderer 移入/移出界面容器；挂起节点暂时放入固定不可见缓存根，防止 Foliate paginator 的未完成帧在 DOM 断开后访问空文档。恢复使用同一对象，不再次调用 `open()`。PDF 没有这组能力，因此仍然在失活时关闭并在重新激活时重建。

### 缓存准入与资源硬预算

首版只准入已经完成首次打开的 EPUB 和 Markdown。PDF、未知格式、打开未完成、单项超限和任意无法证明安全一致性的对象都不准入。当前配置如下；活动 Runtime 上限继续由最多两个 Editor Group 约束。

| 配置 | 桌面 | 平板 |
| --- | ---: | ---: |
| 活动 Runtime | 2 | 2 |
| 挂起 Runtime | 1 | 1 |
| 挂起 iframe 总数 | 4 | 2 |
| 挂起 Canvas 总数 | 0（PDF 禁用） | 0（PDF 禁用） |
| 挂起解码页总数 | 0（PDF 禁用） | 0（PDF 禁用） |
| 挂起范围缓存总量 | 16 MiB | 8 MiB |
| 挂起估算资源总量 | 64 MiB | 32 MiB |

每个新挂起对象先检查单项资源上限，再按最近使用时间淘汰最旧挂起项，直到累计预算满足。淘汰由 `ReaderRuntime` 调用 `BookDocument.close()`；缓存模块本身不直接关闭对象，以保证关闭只有一个拥有者。桌面/平板配置由窗口宽度和指针能力探测，也可在测试中注入固定配置。

### 缓存键与失效

缓存键是版本化不透明 JSON，至少包含：

- `viewId`：ReadingView 稳定身份；
- `materialId`：稳定 MaterialId；
- `contentFingerprint`：托管材料全部字节的完整指纹；
- `documentVersion`：Markdown 正式文档版本，EPUB 为 0；
- `contentAlgorithmVersion`：`epub-canonical-v1|markdown-parser-v1|sanitizer-v1`；
- `format` 与 `reader-runtime-cache-v1` 状态机版本。

键不完全相等就安全 miss 并关闭旧对象。Markdown 正式保存、EPUB 显式版本迁移、材料重新关联或材料永久清理会失效该 MaterialId 的全部缓存；普通移入回收站不改变内容键但关闭/标签关闭仍遵守生命周期。恢复迁移快照同样先清除旧 Runtime，禁止旧指纹继续响应输入。

### 错误恢复

挂起期间发生位置写入失败时不更新活动组，不隐藏原 View。缓存命中后的重新挂载若失败，则关闭该对象、记录可诊断错误，下一次激活按保存位置安全重建；重建仍失败时保留标签和错误状态，不猜测位置。缓存命中永远不能阻止正常的安全重建。

## 性能基线与门槛

`apps/reader/scripts/verify-reader-runtime-cache.mjs` 在真实 Chrome 中通过真实 `library.openBook` 和 `reader.activateView` Command 创建 EPUB/Markdown，执行 A→B→A；脚本由应用真实 `ReadingView` 挂载 renderer，并记录：切出时间、首次可见、回切首次可交互、缓存命中/未命中、托管 Source 范围读取、BookDocument 来源打开次数、renderer 工厂创建次数、iframe/Canvas/解码页/范围缓存资源以及 `performance.memory.usedJSHeapSize`（浏览器可提供时）。

每轮随后清空 Runtime 和缓存，在同一 Chrome 进程、同一材料、同一机器测一次冷回切。默认至少五轮（命令会把小于三轮的配置提升到三轮），报告同时给出缓存命中和冷回切的中位数/P95。门槛不采用固定毫秒数：

1. 每轮必须获得一次缓存命中；命中不能创建新的 BookDocument 来源、renderer 或范围读取；
2. 缓存回切中位数不得超过同机冷回切中位数；
3. 缓存回切 P95 不得超过同机冷回切 P95；
4. 首次可见、资源快照和可获得的内存数据写入脱敏 JSON 报告，便于同机重复测量和比较。

这些门槛由同一轮测得的冷路径派生，换机器或浏览器版本时只比较相对结果，不把某一台机器的绝对耗时当作产品承诺。

## 后果

- 常见 EPUB/Markdown A→B→A 不再重复解析和创建 renderer，回切只需重新挂载同一元素。
- Workspace State 仍完全可序列化，缓存中的 BookDocument、Foliate View、DOM、Canvas、加载任务和 Selection 永不落库。
- 运行时实现增加了 attach/detach 与失效接线，必须在版本变化、永久清理、关闭和异常打开路径保持清理完整。
- 平板采用更小的 iframe、范围和估算资源预算；真实设备证据仍需通过平板冒烟流程，浏览器脚本不能替代原生验收。
