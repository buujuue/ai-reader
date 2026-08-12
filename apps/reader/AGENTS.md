# apps/reader — 阅读器应用

本仓库目前唯一的应用，package 名 `@ai-reader/app`。由前端与 Rust 平台核心两部分组成：

| 目录 | 职责 | 详情 |
| --- | --- | --- |
| `src/` | React + Vite + TypeScript 前端（工作台、命令、状态） | `src/AGENTS.md` |
| `src-tauri/` | Tauri + Rust 平台核心（SQLite、typed 命令、Capability） | `src-tauri/AGENTS.md` |

## 应用级文件

- `package.json`：应用脚本与依赖（React 19、zustand、Tailwind CSS 4、@tauri-apps/api、Vitest、Testing Library）。
- `vite.config.ts` / `vitest.config.ts` / `tsconfig.json`：前端构建、测试与严格类型配置。
- `index.html`：前端入口 HTML。

## 常用命令

```powershell
pnpm dev          # 仅前端(Vite),浏览器降级,内存 Repository
pnpm build        # typecheck + Vite 构建
pnpm verify:ipados # 校验 iPadOS 原生核心冒烟配置
pnpm verify:android # 校验 Android 平板原生核心冒烟配置
pnpm test         # Vitest
pnpm typecheck    # TypeScript 严格模式类型检查
pnpm tauri dev    # Vite + Tauri 完整桌面开发
```

根目录另有 `pnpm tauri build`、`cargo test`、`cargo clippy`，见根 `AGENTS.md` 的“开发命令”。

## 约定

- 新增能力必须复用既有 Command Registry、Repository Interface 与 typed Tauri 命令边界，不另起交互或持久化通道；TS/Rust 职责划分见根 `AGENTS.md` 的“架构边界”。
- 实现任何功能前，先看 Readest 对应部分怎么实现；有能直接复制的代码直接复制移植，尽量少重复造轮子，并按根 `AGENTS.md` 的“重点参考对象：Readest”完成许可登记。
