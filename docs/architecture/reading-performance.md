# 大型 PDF 性能门禁

## 默认浏览器验收

在仓库根目录执行：

```powershell
pnpm --dir apps/reader test:reading-performance
```

脚本会在真实 Chrome 中生成确定性的 640 页 PDF，分别测量浏览器直接 `File` 基线和完整阅读 Command/托管 Source 路径，默认运行至少三次并把中位数写入 `apps/reader/scripts/artifacts/reading-performance.json`。每次托管测量还会打开一个指纹不同的第二份大型 PDF，执行 A→B→A，验证 A 回切复用原 PDF.js 文档、不新增范围读取，并记录位置/视口恢复和挂起资源快照。为保持既有交付覆盖，浏览器模式随后还会执行 EPUB 首屏、资源和章节切换回归。产物已被 `.gitignore` 忽略。

默认门禁要求：首屏 Canvas 有效绘制且文字层或无文字状态完成；一次打开只创建一份 PDF.js 文档；单次范围不超过 8 MiB；累计读取不超过文件大小的 110%；滚动模式活跃 Canvas 不超过 12 个。夹具中的每页内容流都被页面对象引用，不能退化为未引用尾部填充。

## Windows Tauri 生产范围验收

Tauri 开发窗口需开启 WebView2 远程调试端口，并使用显式本地样本：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
pnpm tauri dev

$env:READING_PERFORMANCE_MODE='tauri'
$env:READING_PERFORMANCE_TAURI_DEBUG_URL='http://127.0.0.1:9222'
$env:READING_PERFORMANCE_PDF_PATH='C:\private\large-sample.pdf'
pnpm --dir apps/reader test:reading-performance
```

该模式要求连接到 Windows Tauri WebView，脚本会在同一台机器的 Chrome 中先完成直接 `File` 基线，再暂存并提交显式样本及一个临时指纹变体，从 Tauri 的 `library.openBook` 开始计时并执行 PDF A→B→A；阅读阶段必须通过 `managed-range.localhost` 接收 MaterialId 范围的二进制响应，不使用 Base64 范围载荷或完整文件请求。回切必须复用原 PDF.js 文档且不新增范围读取，挂起 Canvas/解码页/在途读取满足硬预算。Tauri 首屏中位数必须不超过 Chrome 直接 `File` 基线 2 倍；Tauri WebView 内的直接 File 测量仅作为额外诊断，不作为比较基线。

本地样本不进入仓库。浏览器基线为了构造真实 `File` 会在计时前通过临时 loopback 服务器完整载入样本；该导入/装载读取不计入 PDF.js 打开范围指标，计时从 `BookDocument.open` 或 Reader Command 开始。报告只保留样本大小、页数、耗时、范围、解析轮次、内存与 Canvas 指标，不写入样本路径、正文或可还原元数据。成功和失败路径都会关闭阅读运行时、浏览器连接、Vite 与临时样本服务器；Tauri 模式只断开调试连接，不关闭用户启动的 Tauri 进程。

## Issue #60 总验收衔接

`pnpm --dir apps/reader test:reader-runtime-cache` 在真实 Chrome 中验证三种格式的同格式与跨格式标签回切、双 Editor Group 隔离、缓存预算与 Markdown 生命周期；本脚本验证 600 页以上 PDF 的读取/Canvas 门禁和 Windows Tauri `managed-range`。两条命令共同构成有限活 Reader Runtime 的总验收入口，不能用浏览器设备模拟替代 macOS、iPadOS 或 Android 原生证据。
