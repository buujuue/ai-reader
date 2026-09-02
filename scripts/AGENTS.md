# scripts — 仓库级工具脚本

不属于任何应用或 package 的仓库级脚本。

| 脚本 | 用途 |
| --- | --- |
| `generate-icons.mjs` | 生成 AI Reader 应用图标（PNG 32/128/256/512 + 多尺寸 ICO/ICNS），输出到 `apps/reader/src-tauri/icons/`。用法：`node scripts/generate-icons.mjs` |

## 约定

- `verify-macos-core-config.mjs`：校验 macOS 核心阅读冒烟所需的 Tauri 打包、单窗口和最小权限配置。用法：`node scripts/verify-macos-core-config.mjs`
- `verify-ipados-core-config.mjs`：校验 iPadOS 核心阅读冒烟所需的 Tauri 移动入口、文件选择器、安全区元数据和原生工作流步骤。用法：`node scripts/verify-ipados-core-config.mjs`
- `verify-android-core-config.mjs`：校验 Android 平板核心阅读冒烟所需的 Tauri 移动入口、文档选择器、最小权限、返回键、触摸输入、紧凑布局和原生工作流步骤。用法：`node scripts/verify-android-core-config.mjs`
- `android-webview-probe.mjs`：Android 原生冒烟的真实 WebView/CDP 有界就绪探测器与 UIAutomator 语义树采集器；按目标进程、前台 Activity、WebView DevTools 页面和可识别工作台 DOM 判定启动、触摸、重启三个阶段是否就绪，UIAutomator 空快照在有限次数内重试，并拒绝系统错误对话框或不属于目标包的 UIAutomator 证据。配套回归：`pnpm test:android-smoke`。
- `verify-v1-delivery.mjs`：执行第一版交付的静态总验收，检查跨端工作流、安全边界、性能约束、Repository 契约、锁文件和非目标依赖。用法：`pnpm verify:v1`
- Issue #63 的真实格式 Runtime 压力总验收属于 `apps/reader/scripts/`，由 `pnpm --dir apps/reader test:reader-runtime-cache` 执行；本目录同时承载跨端冒烟所需的零依赖运行时探测器和静态交付闸门。

- 图标脚本纯 Node 标准库实现，不引入第三方依赖；新增脚本也应保持零依赖或说明理由。
- 修改图标生成逻辑后，重新运行脚本并提交 `apps/reader/src-tauri/icons/` 下的产物。
