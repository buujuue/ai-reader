# 第一版跨端交付验收记录

本记录对应 GitHub Issue #31，用来把第一版各纵向切片的验收入口、自动化证据和原生证据边界集中起来。它不是新的运行时模块，也不改变既有的 TS/Rust 职责边界。

## 验收入口

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm verify:v1
pnpm typecheck
pnpm test
cargo test
cargo clippy --workspace --all-targets -- -D warnings
pnpm build
```

`pnpm verify:v1` 是静态总验收，只检查可由仓库内容稳定证明的边界；它不会把浏览器降级运行或静态配置检查冒充成原生人工验收。真实浏览器补充验证使用：

```powershell
pnpm --filter @ai-reader/app test:real-render
pnpm --filter @ai-reader/app test:real-search
pnpm --filter @ai-reader/app test:real-annotations
```

## 验收矩阵

| Issue #31 条件 | 仓库证据 | 验收边界 |
| --- | --- | --- |
| Windows 应用级阅读 Seam | `apps/reader/src/app/App.test.tsx`；`workbench/readerCommands.test.ts`；`workbench/markdownCommands.test.ts`；`components/MarkdownSourceEditor.test.tsx` | 覆盖工作台、导入/书库、标签/双组、导航、PDF 搜索、批注、Markdown 编辑和关闭恢复的应用服务 Seam；Windows Tauri 窗口仍需按 README 手工启动确认 |
| 完整备份、整库恢复、单本批注导出 | `src-tauri/src/db/backup.rs`；`workbench/backupCommands.test.ts`；`workbench/annotationExportCommands.test.ts`；`domain/annotation/annotationMarkdown.test.ts` | 成功、取消、损坏包、缺失条目、指纹错误、切换失败和失联批注均有测试；备份恢复只做整库替换，不合并两个书库 |
| 恶意 EPUB/Markdown 与 IPC 安全 | `src/test/fixtures/maliciousContent.ts`；`domain/reader/sanitizer.test.ts`；`foliateViewHost.test.ts`；`src-tauri/capabilities/default.json` | 脚本、iframe、object、embed、事件属性、危险 URL 和协议相对 URL 被清洗；外链被拦截后交给系统；Capability 未开放 `fs:*`、`shell:*` 或 `sql:*` |
| 性能预算 | `src-tauri/src/fs.rs`；`domain/reader/pdf/pdfPageRenderer.test.ts`；`domain/reader/pdf/pdfRangeTransport.test.ts`；`workbench/readerCommands.test.ts`；`components/MaterialCover.tsx` | 导入指纹使用流式复制；PDF 位图有 DPR/面积预算和过期渲染取消；非活动视图释放运行时；封面组件按需读取 |
| Repository 契约 | `domain/**/**Repository.contract.ts`、内存 Adapter 测试、Tauri Adapter 测试；`src-tauri/src/db/` Rust 测试 | TypeScript 内存 Adapter 与 Tauri Adapter 共享领域契约，Rust 在真实 SQLite 连接上运行镜像断言 |
| macOS、iPadOS、Android 原生证据 | `.github/workflows/cross-platform.yml`；[跨端 CI 运行 31575956388](https://github.com/buujuue/ai-reader/actions/runs/31575956388)；三个 `*-core-smoke.md` | 该 CI 运行于 2026-08-12 成功完成 Windows、macOS、iPadOS Simulator、Android 平板 Simulator job，并上传原生构建/启动证据；系统文件选择器、真机触摸、安全区和完整重启流程仍按平台文档补做人工冒烟 |
| 简体中文、依赖锁定与许可 | `App.test.tsx`；`pnpm-lock.yaml`；`Cargo.lock`；`docs/legal/third-party.md` | UI 以简体中文为主，JS/Rust 依赖锁定，foliate-js、PDF.js、Marked、CodeMirror 及平台插件来源均有记录 |
| 非目标没有提前实现 | 根 `package.json`、`apps/reader/package.json`、`apps/reader/src-tauri/Cargo.toml` 与 `pnpm verify:v1` | 第一版运行时不引入 AI、Agent、OCR、账号、云同步、手机、Linux 或完整 Web 产品依赖；`CONTEXT.md` 中的未来领域词汇只是边界记录，不是实现 |
| 工作区结构、命令和架构边界同步 | `AGENTS.md`、各目录 `AGENTS.md`、`CODEMAP.md`、`docs/architecture/overview.md` | 目录、命令、TS/Rust 所有权和跨端验证入口与当前代码一致 |

## Issue #52 树型书库总验收补充

- v2 备份的 `manifest.json` 明确保存 `folders` 和 `materials[].folderId`；SQLite 快照保存完整 Workspace State，Rust 在暂存区校验文件夹树、材料归属、外键和展开状态引用。
- v1 旧备份通过同一恢复协议读取；恢复前只在暂存数据库清除文件夹数据，材料归入未归类，书籍、封面、设置、位置、批注和标签保持不变。
- 应用级入口由 `apps/reader/src/app/App.test.tsx` 验证，Rust 的同版/旧版恢复、损坏层级和原子回滚由 `apps/reader/src-tauri/src/db/backup.rs` 验证；Windows Tauri 的真实导入、树操作、导出/恢复和重启冒烟仍需按本机可用材料执行，不能以浏览器降级测试代替。

## Issue #57 有界 Reader Runtime 总验收补充

Issue #57 的自动化验收由两条互补命令组成：

```powershell
pnpm --dir apps/reader test:reader-runtime-cache
pnpm --dir apps/reader test:reading-performance
```

前一条在真实 Chrome 中通过应用 `library.openBook`、`reader.activateView` 和 Markdown Command 覆盖：

- EPUB↔EPUB、Markdown↔Markdown、PDF↔PDF 及 EPUB/PDF/Markdown 三组跨格式 A→B→A；PDF pair 额外执行 A→B→A→B→A；
- 两个 Editor Group 的 ReadingView/位置隔离、快速连续切换、缓存命中无新文档/renderer/范围读取；
- PDF 挂起的 Canvas、解码页、在途范围读取硬预算；LRU 淘汰、关闭清理和重启恢复；
- Markdown 源码模式、共享会话、编辑失效、正式保存、Recovery Snapshot 和放弃修改。

后一条在浏览器中运行 640 页以上结构型 PDF，并在 Windows Tauri 模式验证同一流程的 `managed-range` 二进制响应、PDF.js 单文档、滚动窗口和 Canvas/范围预算。两条脚本成功和失败路径都写脱敏报告并清理辅助进程；浏览器设备模拟不计作 macOS、iPadOS 或 Android 原生证据。原生平台仍按 `macos-core-smoke.md`、`ipados-core-smoke.md` 和 `android-core-smoke.md` 采集启动、后台返回、位置恢复与重启证据。

## 当前结论

截至 Issue #52 实现提交：

- 静态交付闸门和仓库级测试可以作为 Issue #31 的可重复验收入口；
- 最新跨端 CI 已证明四个平台的构建链、原生启动链和对应模拟器证据上传链路可运行；
- CI 模拟器证据不等于完整人工验收，尤其不能替代 macOS/iPadOS/Android 的系统文件选择器、真实触摸选区、安全区与强制终止恢复检查；
- 在这些人工证据补齐并推送后，才可以关闭 #28、#29、#30，随后关闭 #31。本机为 Windows，不能在本地虚报上述 Apple/Android 人工结果。

## 本次验证记录

2026-08-12（Windows 工作区）：

- `pnpm verify:v1`：通过，10 项静态检查全部通过；
- `pnpm verify:macos`、`pnpm verify:ipados`、`pnpm verify:android`：全部通过；
- `pnpm typecheck`：通过；`pnpm test`：51 个测试文件、490 个测试全部通过；
- `cargo test`：76 个 Rust 测试全部通过；`cargo clippy --workspace --all-targets -- -D warnings`：通过；
- `pnpm build`：通过；Vite 产物生成成功；
- `pnpm --filter @ai-reader/app test:real-render`：本机真实浏览器启动超时。默认 Chrome 路径不存在，改用本机 Edge 作为 `CHROME_PATH` 后仍在 Puppeteer 启动阶段超时，因此没有把该项记为通过，也没有继续伪造搜索/批注浏览器证据；
- GitHub Actions 跨端运行 [31575956388](https://github.com/buujuue/ai-reader/actions/runs/31575956388)：Windows、macOS、iPadOS Simulator、Android 平板 Simulator 四个 job 全部成功。

平台人工步骤与证据格式：

- [macOS 核心阅读冒烟](./macos-core-smoke.md)
- [iPadOS 核心阅读冒烟](./ipados-core-smoke.md)
- [Android 平板核心阅读冒烟](./android-core-smoke.md)
- [跨端验证约束](./cross-platform-validation.md)
