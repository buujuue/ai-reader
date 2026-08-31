# iPadOS 核心阅读冒烟

## 目的

验证 AI Reader 在 iPadOS 原生 WebView 中可以完成第一版核心阅读链路。浏览器开发模式只用于快速反馈布局，不能作为 iPadOS 验收证据。

## 前置条件

- macOS 主机安装 Xcode、Command Line Tools、Node.js 22、pnpm 10 和 Rust；
- 仓库依赖已安装：`pnpm install`；
- iPad Simulator 或已连接的 iPad 真机可用。

## 原生启动

在仓库根目录先运行：

```powershell
pnpm verify:ipados
```

然后生成并启动 Tauri iOS 工程：

```powershell
cd apps/reader
pnpm tauri ios init
pnpm tauri ios dev
```

也可以使用 CI 同款的模拟器构建命令：

```powershell
pnpm tauri ios build --debug --target aarch64-sim
```

## 验收步骤

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 原生启动 | 从 Simulator 或真机打开 AI Reader | 显示工作台，不是浏览器页面；顶部和底部内容不被刘海、状态栏或 Home Indicator 遮挡 |
| 系统导入 | 通过导入命令打开系统文件选择器，分别选择 EPUB、PDF、Markdown | 材料复制到托管书库，返回书库后可以打开；不直接依赖原始路径 |
| EPUB 触摸阅读 | 打开 EPUB，左右滑动翻页，再上下滚动可滚动页面 | 分页材料响应翻页；滚动流式内容不误触发翻页 |
| 选区优先 | 在文本上长按并拖动选区，再做横向移动 | 选区和系统菜单保持可用，不被页面手势拦截 |
| 位置恢复 | 翻到非首屏，等待位置写入后强制退出并重新打开 | 工作区恢复原标签和阅读位置 |
| 安全区与旋转 | 分别验证竖屏、横屏，并观察顶部工具栏和底部状态栏 | 内容始终位于安全区内，旋转后布局重新计算 |
| Split View | 进入 iPadOS 分屏并改变容器宽度 | `LayoutPolicy` 随容器宽度变化；紧凑宽度显示活动组和覆盖抽屉，隐藏组及侧栏期望状态不丢失 |
| Runtime 缓存 | 打开 EPUB、Markdown、PDF，执行 A→B→C→A；再切到后台并返回 | 三 resident 命中时位置/视口和正文立即恢复；内存预算不足时安全重建；后台返回先 flush 位置，不能出现旧正文或孤儿页面 |

## 证据记录

保存以下证据：原生启动日志、竖屏截图、横屏截图、导入结果、Runtime 缓存命中/退化状态和重启恢复前后的位置。CI 自动上传 iPad Simulator 的启动日志与截图；CI 不替代真机文件选择器、触摸、安全区和 Runtime 缓存的完整人工检查。

Issue #63 的原生记录使用字段：`platform`、`osVersion`、`deviceModel`、`appCommit`、`recordedAt`、`cacheHit`、`backgroundReturn`、`budgetFallback`、`locationRestored`、`artifactNames`。浏览器设备模拟不得填写这些字段；未完成真机或 Simulator 行为验收时明确记为 `pending`。
