# 跨端验证约束

## 主工作流

仓库工作流 `.github/workflows/cross-platform.yml` 监听以下事件：

- 每次推送到 `main`；
- Pull Request；
- 手动触发。

每次 `main` 推送都会在同一轮工作流中并行执行 Windows、macOS、iPadOS 和 Android 平板验证。Windows 与 macOS 运行 TypeScript 类型检查、前端测试、Rust 测试、Clippy、前端构建和原生打包；iPadOS 额外生成 Tauri iOS 原生工程，构建 iPad Simulator 应用，启动原生 WebView，并上传启动日志与模拟器截图；Android 额外生成 Tauri Android 原生工程，构建 debug APK，安装到 Android 平板模拟器，采集触摸和进程重启后的真实 WebView 截图与 `adb logcat`。

“同步”指同一条工作流必须等所有平台任务完成后才得出最终结果；平台任务可以并行执行，但任一端失败都会使本次验证失败。工作流不会取消同一分支上较早的运行，因此每次推送都有对应的验证结果。

## iPadOS 原生证据边界

iPadOS job 必须使用 macOS runner、Xcode Simulator 和 Tauri iOS 构建链路。`xcrun simctl launch --console` 的启动日志以及 `xcrun simctl io screenshot` 生成的截图属于真实 iPadOS WebView 证据；它们不是浏览器 User-Agent 或 DevTools 设备模拟。

CI 证据覆盖“原生应用可以构建、安装、启动并显示 WebView”。系统文件选择器导入、触摸翻页、文本选区优先级、位置重启恢复、安全区、旋转和 Split View 的完整场景仍按 [`ipados-core-smoke.md`](./ipados-core-smoke.md) 在 macOS 主机或 iPad 真机执行。

浏览器 `pnpm dev`、浏览器端设备模拟或只在 Windows 本地运行，都不能替代 iPadOS 原生证据。

## Issue #60 三 resident Reader Runtime 证据边界

Windows job 在真实 Chrome 中执行 `pnpm --dir apps/reader test:reader-runtime-cache`，并上传 `reader-runtime-cache.json`；该脚本现包含 Issue #60 的 EPUB→Markdown→PDF→EPUB 三 resident 基线及 Issue #57 的格式回归。Windows Tauri 的 600 页以上 PDF 范围协议与 Canvas 门禁仍由 `pnpm --dir apps/reader test:reading-performance` 按显式远程调试步骤执行。该两项是桌面总验收证据。

macOS、iPadOS 和 Android 平板的构建 job 只证明原生 WebView 的构建、安装、启动与基础触摸/重启链路。三端的三 resident Runtime 命中、超预算安全重建、后台返回和位置恢复必须在真实原生 WebView 中按各自冒烟文档记录，至少覆盖 EPUB→Markdown→PDF→EPUB 的一组切换；浏览器脚本结果只能作为逻辑补充，不能填充原生证据空缺。

## Android 平板原生证据边界

Android job 必须使用 Linux Android runner、Tauri Android 构建链和 Android 平板模拟器；`adb install`、真实 WebView 截图和 `adb logcat` 一并上传。该证据不等同于浏览器 User-Agent 模拟，且不替代系统文档选择器、最小权限和实际平板触摸行为的真机验收。完整步骤记录在 [`android-core-smoke.md`](./android-core-smoke.md)。

## 新增平台

新增平台若需要专用工具链、签名或模拟器，应在同一工作流中新增对应 job，并明确把它纳入 `main` 推送的必跑路径；不要把它拆成只在手动触发时运行的旁路验证。更新时只记录已经存在、可验证的路径和命令；架构决策本身变化时，还要同步更新 `docs/architecture/overview.md` 和相应 ADR。
