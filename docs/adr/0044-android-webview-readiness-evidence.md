# ADR-0044：Android 原生冒烟以真实 WebView 就绪条件采集证据

- 状态：已接受
- 日期：2026-09-01
- 关联工单：#64

## 背景

Android 35 平板模拟器的冷启动速度不是固定值。单次固定等待后截图可能得到空白 WebView，UIAutomator 也可能产生零字节结果；后续读取缺失文件会遮蔽真正的启动失败阶段。Readest 的 Android 验收已证明，通过 `webview_devtools_remote_<pid>` 转发真实 WebView 的 Chrome DevTools Protocol，并轮询可观察页面状态，可以把手势和渲染验收与设备启动速度解耦。

## 决策

- `.github/scripts/android-emulator-smoke.sh` 的 `start`、`touch` 和 `restart` 阶段都先调用根脚本 `scripts/android-webview-probe.mjs`。
- Android 35 Job 使用普通 AOSP `default` 系统镜像；当前验收不依赖 Google Play 服务，因此不让 Google 首次设置进程和系统错误弹窗进入应用证据。ATD 会削弱截图所需的渲染能力，不用于本验收。
- 探测必须在有界上限内同时满足目标进程存活、目标包位于前台、WebView DevTools socket 可转发、CDP 页面可连接，以及 AI Reader 工作台关键 DOM 节点可见且文档状态为 `complete`。
- 前台包以 `dumpsys activity activities` 的 resumed Activity 判定，不依赖 Android 35 已不再稳定提供的旧 `dumpsys window windows` 焦点摘要。
- UIAutomator 证据必须包含目标包，并拒绝 `android:id/aerr_*` 系统错误对话框；应用 DOM 已就绪但被系统弹窗覆盖时不得报告成功。
- 探测使用有界轮询；单次探测也受当前剩余上限约束，超时报告阶段、尝试次数、最后状态和上限，不允许把空白截图视为成功。
- 证据按阶段保存截图、UIAutomator 语义树、前台 Activity、目标进程、WebView 探测 JSON、动作日志和最终 `adb logcat`。动作、探测或证据校验失败时，退出钩子仍尽力保存当前设备状态，并以失败阶段作为诊断入口。
- `pnpm test:android-smoke` 只测试探测器的成功、重试和超时语义，不伪造 Android 原生证据；真实 Android 证据仍由跨端 Job 和平台冒烟流程提供。

## 后果

慢速模拟器会等待实际工作台就绪而不是等待固定秒数；初始化失败会在上限内明确失败，且 artifact 保留足够的设备状态用于定位。探测器依赖 Node 标准库和 `adb`/Android WebView 已有能力，不新增应用运行时依赖，也不改变 TypeScript/Rust 职责边界。

## 参考与许可

实现参考 Readest `apps/readest-app/docs/testing.md` 与 `apps/readest-app/src/__tests__/android/helpers/cdp.ts` 的 WebView DevTools 转发、CDP 页面探测和“poll, don't sleep”约定；AI Reader 仅按自身阶段证据需求重新实现，没有直接复制代码，因此不新增第三方代码登记。
