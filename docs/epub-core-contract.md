# EPUB 核心阅读循环契约与验收样书

状态：冻结（工单 01）

本文件把 EPUB 核心阅读循环的“完整支持、局部降级、整书拒绝”边界固化为可重复执行的验收基线。样书目录和自动检查位于 `apps/reader/src/test/fixtures/epub/`；任何后续实现都必须先通过这份基线，再讨论扩大支持范围。

## 判定结果

| 结果 | 含义 | 用户可见要求 |
| --- | --- | --- |
| `supported` | 核心内容、导航和阅读方向可以按样书预期使用 | 导入成功，首次打开、章节切换和目录行为可用 |
| `degraded` | 静态阅读循环可继续，但某项能力被安全或平台边界限制 | 明确显示限制；不得假装互动能力仍然可用 |
| `rejected` | 结构、授权或资源预算不满足安全/完整性要求 | 不创建托管材料；显示可行动的拒绝原因 |

“降级”不能静默变成错误内容；“拒绝”不能先把超限内容完整解压到内存或磁盘。

## 样书覆盖矩阵

样书是项目生成的最小 EPUB，不下载、不复制版权不明的商业电子书。完整的机器可读定义以 `epubFixtureContract.ts` 为准。

| 样书 | 覆盖内容 | 预期 | 用户可见结果 |
| --- | --- | --- | --- |
| `epub2-ncx-flowable` | EPUB 2、流式、NCX | 完整支持 | 正文和分层目录可用 |
| `epub3-nav-rich` | EPUB 3、流式、NAV、图片、SVG、脚注 | 完整支持 | 图片/SVG/脚注跳转可用 |
| `epub3-fixed-layout` | 固定版式、NAV、图片、SVG | 完整支持 | 固定版式章节可阅读 |
| `epub3-rtl-vertical` | RTL、竖排 | 完整支持 | RTL 与竖排方向保持 |
| `epub3-obfuscated-font` | 字体混淆 | 局部降级 | 字体不可用时回退并提示 |
| `epub3-mathml` | MathML | 局部降级 | 公式失败时保留替代内容/提示 |
| `epub3-missing-toc` | 缺失目录 | 局部降级 | 目录面板说明没有可用目录 |
| `epub3-corrupt-toc` | 损坏目录 | 局部降级 | 目录面板说明目录损坏，正文仍可打开 |
| `epub3-audio-video` | 音频/视频 | 局部降级 | 媒体控件禁用并说明不受支持 |
| `epub3-scripted-content` | 脚本 | 局部降级 | 脚本不执行，互动部分不可用 |
| `epub3-remote-active-resource` | 远程活动资源 | 局部降级 | 远程资源不加载，静态正文保留 |
| `epub3-corrupt-package` | 损坏包 | 整书拒绝 | 提示包损坏，不生成托管材料 |
| `epub3-commercial-drm` | 商业 DRM | 整书拒绝 | 明确说明不支持 DRM，不解密/联网 |
| `epub3-compression-ratio-limit` | 压缩比超限 | 整书拒绝 | 不进行解压 |
| `epub3-chapter-size-limit` | 章节大小超限 | 整书拒绝 | 提示章节超过安全上限 |
| `epub3-entry-count-limit` | 条目数量超限 | 整书拒绝 | 提示 ZIP 条目过多 |
| `epub3-xml-depth-limit` | XML/HTML 嵌套过深 | 整书拒绝 | 提示文档嵌套过深 |
| `epub3-zip-bomb` | 恶意压缩包，多项预算同时超限 | 整书拒绝 | 不产生托管文件 |

## 资源预算

第一版跨目标平台使用同一组硬上限：

| 指标 | 上限 |
| --- | ---: |
| 单条目解压大小 | 64 MiB |
| 总解压大小 | 256 MiB |
| 压缩比（解压后/压缩后） | 100 倍 |
| 单章节解压大小 | 8 MiB |
| ZIP 条目数量 | 10,000 |
| XML/HTML 最大嵌套深度 | 64 |

解析顺序必须是“读取中央目录元数据 → 预算预检 → 受控解压 → 解析内容”。任何一个指标超限都属于 `rejected`；不能通过仅显示警告来绕过预算。

这些是资源安全上限，不是设备性能目标。实际性能仍按平台单独记录，但不能提高某个平台的安全上限。

## 基准协议

每个目标平台至少对 `epub3-nav-rich` 和 `epub3-fixed-layout` 运行 3 次，记录以下阶段：

1. `import`：从外部文件进入托管书库完成的耗时。
2. `first-open`：导入完成到首次正文可见/首个位置事件的耗时。
3. `chapter-switch`：从第一章切换到下一章并产生新位置的耗时。
4. `memory`：每个阶段结束时的进程或 JS 堆内存读数；无法获取时记录 `null`，不得伪造数字。

记录格式为 `epub-benchmark.v1`，包含样书 ID、平台、迭代编号、阶段、耗时和内存。`epubBenchmark.ts` 提供注入式运行器；Windows Tauri、浏览器降级和移动端冒烟只需提供相同 hooks，即可比较同一格式的结果。

## 来源、许可和生成

- 来源：项目自生成的最小测试内容，不来自外部电子书。
- 生成器：`apps/reader/src/test/fixtures/epub/epubFixtures.ts`。
- 许可：随项目 AGPL-3.0 发布。
- 可重复性：ZIP 时间戳、条目顺序和内容固定；生成器不使用随机数、系统路径或网络。
- 参考实现：Readest 的 EPUB 测试采用真实样书对照 JS/Rust 解析结果；本切片先用可审计的本地生成样书冻结产品边界，后续若加入外部样书，必须另行登记来源、许可证和固定版本。

## 验证

在仓库根目录运行：

```powershell
pnpm --filter @ai-reader/app test -- src/test/fixtures/epub/epubCoreContract.test.ts
```

成功标准：覆盖矩阵、资源预算、NAV/NCX 结构、可重复生成和四阶段基准记录测试全部通过。
