# 大型 PDF 性能门禁

## 默认浏览器验收

在仓库根目录执行：

```powershell
pnpm --dir apps/reader test:reading-performance
```

脚本会在真实 Chrome 中生成确定性的 640 页 PDF，分别测量浏览器直接 `File` 基线和完整阅读 Command/托管 Source 路径，默认运行至少三次并把中位数写入 `apps/reader/scripts/artifacts/reading-performance.json`。产物已被 `.gitignore` 忽略。

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

该模式要求连接到 Windows Tauri WebView，暂存并提交显式样本后从 `library.openBook` 开始计时；阅读阶段必须通过 `managed-range.localhost` 接收 MaterialId 范围的二进制响应，不使用 Base64 范围载荷或完整文件请求。Tauri 首屏中位数必须不超过同一页面的浏览器直接 `File` 基线 2 倍。

本地样本不进入仓库。报告只保留样本大小、页数、耗时、范围、解析轮次、内存与 Canvas 指标，不写入样本路径、正文或可还原元数据。成功和失败路径都会关闭阅读运行时、浏览器连接、Vite 与临时样本服务器；Tauri 模式只断开调试连接，不关闭用户启动的 Tauri 进程。
