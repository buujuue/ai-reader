# 跨端验证约束

## 主工作流

仓库工作流 `.github/workflows/cross-platform.yml` 监听以下事件：

- 每次推送到 `main`；
- Pull Request；
- 手动触发。

每次 `main` 推送都会在同一轮工作流中并行执行 Windows、macOS 和 iPadOS 验证。Windows 与 macOS 运行 TypeScript 类型检查、前端测试、Rust 测试、Clippy、前端构建和原生打包；iPadOS 额外生成 Tauri iOS 原生工程，构建 iPad Simulator 应用，启动原生 WebView，并上传启动日志与模拟器截图。

“同步”指同一条工作流必须等所有平台任务完成后才得出最终结果；平台任务可以并行执行，但任一端失败都会使本次验证失败。工作流不会取消同一分支上较早的运行，因此每次推送都有对应的验证结果。

## iPadOS 原生证据边界

iPadOS job 必须使用 macOS runner、Xcode Simulator 和 Tauri iOS 构建链路。`xcrun simctl launch --console` 的启动日志以及 `xcrun simctl io screenshot` 生成的截图属于真实 iPadOS WebView 证据；它们不是浏览器 User-Agent 或 DevTools 设备模拟。

CI 证据覆盖“原生应用可以构建、安装、启动并显示 WebView”。系统文件选择器导入、触摸翻页、文本选区优先级、位置重启恢复、安全区、旋转和 Split View 的完整场景仍按 [`ipados-core-smoke.md`](./ipados-core-smoke.md) 在 macOS 主机或 iPad 真机执行。

浏览器 `pnpm dev`、浏览器端设备模拟或只在 Windows 本地运行，都不能替代 iPadOS 原生证据。

## 新增平台

新增平台若需要专用工具链、签名或模拟器，应在同一工作流中新增对应 job，并明确把它纳入 `main` 推送的必跑路径；不要把它拆成只在手动触发时运行的旁路验证。更新时只记录已经存在、可验证的路径和命令；架构决策本身变化时，还要同步更新 `docs/architecture/overview.md` 和相应 ADR。
