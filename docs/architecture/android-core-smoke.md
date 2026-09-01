# Android 平板核心阅读冒烟

Issue #30 的 Android 平板验收分为自动化原生证据与真机手工流程两部分。自动化 job 使用 Tauri Android 工程、x86_64 平板模拟器和系统 WebView，手工流程用于系统文件选择器与权限行为。

## 自动化证据

`.github/workflows/cross-platform.yml` 的 `android` job 会：

- 生成 Tauri Android 工程并构建 debug APK；
- 将 APK 安装到使用普通 AOSP `default` 系统镜像的 `Pixel_C` Android 35 模拟器，避免无关 Google 首次设置进程与系统弹窗污染原生证据；
- 启动真实 Android WebView，先按有界轮询确认目标进程位于前台、WebView DevTools 页面可连接且 AI Reader 工作台已完成绘制，再保存启动、触摸后、进程强制终止并重启后的截图；
- 保存安装日志、启动日志、重启日志和 `adb logcat`；
- 在构建与测试前运行 `pnpm verify:android`、类型检查、前端测试和 Rust 测试。

截图和日志通过 `ai-reader-android-<sha>` artifact 提供。该证据证明原生工程可以构建、安装、启动，且触摸输入和进程重启路径进入真实 WebView。

### 就绪条件与阶段证据

`.github/scripts/android-emulator-smoke.sh` 不以固定等待时间判断启动成功，而是调用 `scripts/android-webview-probe.mjs`，在有界时间内轮询以下条件：

- 目标包进程仍然存活；
- Activity 管理器报告的 resumed Activity 属于目标包；
- `webview_devtools_remote_<pid>` 调试 socket 已出现并可通过 `adb forward` 访问；
- CDP `Runtime.evaluate` 能看到可见的 `.app-shell`、应用顶栏、`AI Reader` 标识、`#reader-main` 和编辑器区。

探测通过 `dumpsys activity activities` 读取 Android 35 的 resumed Activity，不依赖新版系统已不稳定输出的旧窗口焦点摘要。UIAutomator 语义树必须包含目标包，并拒绝 `android:id/aerr_*` 系统错误对话框，避免把被 ANR 弹窗覆盖的工作台误当成有效证据。探测超时会指出 `start`、`touch` 或 `restart` 阶段、尝试次数、最后一次状态和上限，不会把空白截图误判为成功。每个阶段都保存 `*-webview-probe.json`、`*-foreground-activity.txt`、`*-target-process.txt`、截图和 UIAutomator 语义树；任一阶段失败时，退出钩子仍会采集当前设备状态和 `android-logcat.txt`，避免后续读取不存在文件掩盖原始原因。探测器的立即成功、重试成功和超时诊断由 `pnpm test:android-smoke` 覆盖。

## 真机验收流程

使用 Android 平板执行以下流程，并记录设备型号、Android 版本、应用版本、截图和 `adb logcat`：

1. 从书库点击导入，使用系统文档选择器选择 EPUB；确认选择器只返回用户选定的 URI，应用可正常完成托管复制。
2. 打开 EPUB，分别使用轻触和左右滑动翻页；在正文中拖动选择文本，确认选择优先于翻页。
3. 依次打开 EPUB、Markdown、PDF，执行 A→B→C→A；确认三 resident 命中时位置、PDF 视口和正文立即恢复，超出平板预算时安全重建且没有孤儿 Canvas/范围读取。
4. 将应用切到后台再返回，确认先 flush 可序列化位置，恢复后不显示旧正文；强制停止应用并重新启动，确认工作区、阅读位置和 Markdown Recovery Snapshot 按协议恢复。
5. 打开紧凑布局下的抽屉、目录、搜索、Markdown 源码模式和脏文档关闭确认，逐次按系统返回键；确认每次只退出当前次级状态，不静默丢弃 Markdown。
6. 在系统设置中撤销文件访问权限后再次导入，确认应用只报告当前导入失败，不获得共享存储的任意访问能力。

Issue #63 的原生记录使用字段：`platform`、`osVersion`、`deviceModel`、`appCommit`、`recordedAt`、`cacheHit`、`backgroundReturn`、`budgetFallback`、`locationRestored`、`artifactNames`。浏览器设备模拟不得代填；未完成真实 Android WebView 行为验收时明确记为 `pending`。

## 相关实现边界

- `filePicker.ts` 使用 Android 文档选择器、MIME 类型和 `fileAccessMode: 'copy'`，导入后的读取和托管复制仍由现有 typed repository 完成。
- `androidBackButton.ts` 只解析“关闭当前次级状态”的动作；恢复快照对话框保持打开，脏 Markdown 不会被返回键静默丢弃。
- `readingInput.ts` 保留触摸选择优先级，`layoutPolicy.ts` 保留紧凑布局的单抽屉行为。
