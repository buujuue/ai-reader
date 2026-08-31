# apps/reader — 阅读器应用

本仓库目前唯一的应用，package 名 `@ai-reader/app`。由前端与 Rust 平台核心两部分组成：

| 目录 | 职责 | 详情 |
| --- | --- | --- |
| `src/` | React + Vite + TypeScript 前端（工作台、命令、状态、ManagedFileSource） | `src/AGENTS.md` |
| `src-tauri/` | Tauri + Rust 平台核心（SQLite、typed 命令、Capability） | `src-tauri/AGENTS.md` |

## 应用级文件

- `package.json`：应用脚本与依赖（React 19、zustand、Tailwind CSS 4、@tauri-apps/api、Vitest、Testing Library）。
- `vite.config.ts` / `vitest.config.ts` / `tsconfig.json`：前端构建、测试与严格类型配置。
- `index.html`：前端入口 HTML。
- `src/app/bootstrap.ts`：组装应用级 Adapter（含独立 `LibraryFolderRepository` 与管理材料文件夹归属的 `ImportRepository`）；EPUB 推导目录缓存必须经 `EpubDerivedTocCache` typed 接口注入，Tauri 运行时使用 Rust 私有派生缓存，浏览器降级使用内存缓存。

## 常用命令

```powershell
pnpm dev          # 仅前端(Vite),浏览器降级,内存 Repository
pnpm build        # typecheck + Vite 构建
pnpm verify:ipados # 校验 iPadOS 原生核心冒烟配置
pnpm verify:android # 校验 Android 平板原生核心冒烟配置
pnpm test:real-epub-p0 # 真实 Chrome 验证 EPUB 2/3 P0 阅读矩阵
pnpm test:reading-performance # 真实 Chrome 验证大型 EPUB/PDF 范围读取性能
pnpm test:reader-runtime-cache # 真实 Chrome 验证三材料同/混合格式轮换、资源压力与安全冷重建
pnpm test         # Vitest
pnpm typecheck    # TypeScript 严格模式类型检查
pnpm tauri dev    # Vite + Tauri 完整桌面开发
```

根目录另有 `pnpm tauri build`、`cargo test`、`cargo clippy`，见根 `AGENTS.md` 的“开发命令”。

## 约定

- 新增能力必须复用既有 Command Registry、Repository Interface 与 typed Tauri 命令边界，不另起交互或持久化通道；文件夹删除必须通过 `library.deleteFolder` 的确认/事务语义；TS/Rust 职责划分见根 `AGENTS.md` 的“架构边界”。
- 标签切换由 `reader.activateView` 统一编排：已完成的 EPUB/Markdown/PDF Runtime 按 ReadingView 身份进入 ADR-0041/0043 的三 resident 有界缓存；最多两个 active，剩余 resident 为 suspended，容量不足只按 LRU 淘汰 suspended；桌面最多聚合保留两个、平板最多一个 suspended PDF 当前页，且继续受 16/8 MiB 字节预算约束；挂起时断开观察器、输入与后台调度，符合 ADR-0042 快照时同步复挂当前页并延后邻页；回收站只清除挂起对象，材料版本替换/重新关联/永久删除和整库恢复则关闭相关活对象。
- Markdown 源码模式切换由 Markdown Command 编排：CodeMirror 独占可见编辑区时挂起 Foliate，缓冲区、正式版本和恢复快照变化先使全部相关 Runtime 失效，再按共享会话文本恢复非源码视图。
- 实现任何功能前，先看 Readest 对应部分怎么实现；有能直接复制的代码直接复制移植，尽量少重复造轮子，并按根 `AGENTS.md` 的“重点参考对象：Readest”完成许可登记。
