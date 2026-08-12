# Android 平板核心阅读冒烟

Issue #30 的 Android 平板验收分为自动化原生证据与真机手工流程两部分。自动化 job 使用 Tauri Android 工程、x86_64 平板模拟器和系统 WebView，手工流程用于系统文件选择器与权限行为。

## 自动化证据

`.github/workflows/cross-platform.yml` 的 `android` job 会：

- 生成 Tauri Android 工程并构建 debug APK；
- 将 APK 安装到 `Pixel_C` Android 35 模拟器；
- 启动真实 Android WebView，保存启动、触摸后、进程强制终止并重启后的截图；
- 保存安装日志、启动日志、重启日志和 `adb logcat`；
- 在构建与测试前运行 `pnpm verify:android`、类型检查、前端测试和 Rust 测试。

截图和日志通过 `ai-reader-android-<sha>` artifact 提供。该证据证明原生工程可以构建、安装、启动，且触摸输入和进程重启路径进入真实 WebView。

## 真机验收流程

使用 Android 平板执行以下流程，并记录设备型号、Android 版本、应用版本、截图和 `adb logcat`：

1. 从书库点击导入，使用系统文档选择器选择 EPUB；确认选择器只返回用户选定的 URI，应用可正常完成托管复制。
2. 打开 EPUB，分别使用轻触和左右滑动翻页；在正文中拖动选择文本，确认选择优先于翻页。
3. 离开当前页面后重新打开材料，确认阅读位置保持；强制停止应用并重新启动，确认工作区、阅读位置和 Markdown Recovery Snapshot 按协议恢复。
4. 打开紧凑布局下的抽屉、目录、搜索、Markdown 源码模式和脏文档关闭确认，逐次按系统返回键；确认每次只退出当前次级状态，不静默丢弃 Markdown。
5. 在系统设置中撤销文件访问权限后再次导入，确认应用只报告当前导入失败，不获得共享存储的任意访问能力。

## 相关实现边界

- `filePicker.ts` 使用 Android 文档选择器、MIME 类型和 `fileAccessMode: 'copy'`，导入后的读取和托管复制仍由现有 typed repository 完成。
- `androidBackButton.ts` 只解析“关闭当前次级状态”的动作；恢复快照对话框保持打开，脏 Markdown 不会被返回键静默丢弃。
- `readingInput.ts` 保留触摸选择优先级，`layoutPolicy.ts` 保留紧凑布局的单抽屉行为。
