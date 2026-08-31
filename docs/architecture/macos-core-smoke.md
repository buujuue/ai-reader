# macOS 核心阅读原生冒烟

本记录对应 GitHub Issue #28。它验证 macOS 原生壳复用与 Windows 相同的 React 工作台、Command Registry、Repository Interface 和 typed Tauri Command，不建立 macOS 专用阅读领域分支。

## 运行前提

- macOS 12 或更高版本；记录 Apple Silicon 或 Intel 架构。
- Node.js 22+、pnpm 10+、Rust stable，以及 Tauri v2 所需的 Xcode Command Line Tools。
- 在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm verify:macos
```

`verify:macos` 是不依赖桌面环境的配置回归检查；成功时输出 `macOS core configuration is valid`。

## 原生验证

在真实 macOS 主机上执行：

```bash
sw_vers
uname -m
pnpm tauri dev
```

`pnpm tauri dev` 启动的是真实 Tauri macOS 应用，不是浏览器模拟。关闭开发窗口后，再执行打包检查：

```bash
pnpm tauri build
```

预期生成：

- `target/release/bundle/macos/AI Reader.app`
- `target/release/bundle/dmg/AI Reader_0.1.0_aarch64.dmg`（Apple Silicon）或对应 Intel 文件名

## 冒烟步骤与证据

| 验收项 | 操作 | 真实 macOS 证据 |
| --- | --- | --- |
| 单窗口与简体中文工作区 | 启动应用，确认只有一个 `main` 窗口，活动栏、书库和状态栏为简体中文 | 记录窗口截图或短视频；不要用浏览器截图替代 |
| 系统文件选择与托管导入 | 点击导入，使用 macOS 文件选择器选择 EPUB；确认书库出现材料，原文件未被修改 | 记录文件选择器、书库卡片和原文件校验值 |
| EPUB 阅读与位置恢复 | 打开 EPUB，翻到下一页，关闭应用，再启动并确认位置恢复 | 记录关闭前后章节/页码 |
| PDF 与 Markdown 冒烟 | 分别导入并打开 PDF、Markdown，确认阅读视图出现且未创建平台专用分支 | 记录各自打开后的原生窗口 |
| Runtime 缓存与后台返回 | 打开 EPUB、Markdown、PDF，执行 A→B→C→A，再隐藏窗口并恢复 | 记录三 resident 命中时位置/视口立即恢复、超预算安全重建、后台返回后的 flush 结果和无孤儿页面 |
| 外部链接与权限 | 点击书内外部链接，确认先出现确认对话框，再由系统默认浏览器打开；不要把 URL 导航到阅读 WebView | 记录默认浏览器打开结果；检查内容页没有 Tauri IPC 能力 |

## 证据边界

以下命令可以验证领域逻辑或浏览器降级路径，但不计入 macOS 原生验收：

```bash
pnpm dev
pnpm test
pnpm --filter @ai-reader/app test:real-render
```

Windows 上的 `pnpm tauri dev` 只能证明 Windows 原生壳仍可启动；本仓库当前开发主机不是 macOS，因此本次实现不虚报真实 macOS 运行证据。Issue #60 的 `test:reader-runtime-cache` 结果不能替代上表的 macOS 三 resident Runtime 缓存证据。完成原生验收后，将主机信息、命令、时间、结果和截图路径补充到本表对应行。

## 安全边界检查

`apps/reader/src-tauri/capabilities/default.json` 只向 `main` 窗口授予：

- `dialog:allow-open`：导入材料、封面和备份源选择；
- `dialog:allow-save`：备份与单本批注导出目标选择；
- `opener:allow-open-url`：把已确认的外部链接交给系统浏览器。

没有授予 `fs:*`、`shell:*` 或 `sql:*` 插件权限。阅读内容仍通过清洗、CSP 和应用自身的 typed Command 边界访问数据；它不会获得任意文件系统或额外 Tauri IPC 能力。
