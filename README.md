# AI Reader

独立、轻量、跨 PC 与平板的本地阅读器。第一版先跑通类 VS Code 的阅读工作区与 EPUB、PDF、Markdown 阅读链路;不实现 AI、账号、云同步或 OCR。

当前进度:第一版底座(工单 #1)已就绪——Windows 原生应用可启动,简体中文工作台外壳、Command Registry 与 typed Repository/Tauri Command 的完整往返可验证。随后已落地:EPUB 导入与重启续读、严查重与回收站、书库元数据与封面、目录/搜索/导航历史,以及可调整并持久化的阅读排版(字体、字号、行距、页边距、主题、分页/滚动)。

## 快速开始

前置工具:

- Node.js ≥ 22 与 pnpm ≥ 10(`packageManager` 已在根 `package.json` 固定)
- Rust stable 与平台编译工具链(Windows 需 MSVC + WebView2 运行时)

```powershell
# 安装 JS 依赖
pnpm install

# 浏览器降级开发(内存 Repository,不启动 Tauri)
pnpm dev

# 完整桌面开发(启动 Vite + Tauri)
pnpm tauri dev

# 构建前端与原生应用
pnpm build              # 前端类型检查 + Vite 产物
pnpm tauri build        # 原生应用(含 NSIS 安装包)
pnpm tauri build --no-bundle  # 只生成可执行文件

# 测试与检查
pnpm test               # Vitest(工作台、Command、仓库契约)
pnpm typecheck          # TypeScript 严格模式检查
cargo test              # Rust 迁移、workspace 持久化契约
cargo clippy --workspace --all-targets -- -D warnings
```

## 仓库结构

```text
ai-reader/
├── apps/reader/               # 阅读器应用
│   ├── src/                   # React + TypeScript 前端
│   │   ├── app/               # 应用入口、bootstrap、服务上下文
│   │   ├── commands/          # Command Registry 与稳定 Command ID
│   │   ├── components/        # 工作台外壳组件(活动栏/侧栏/状态栏)
│   │   ├── domain/workspace/  # 工作区状态类型与 Repository Adapter
│   │   └── workbench/         # Workspace Store 与工作台命令处理
│   └── src-tauri/             # Rust 平台核心(Tauri + SQLite)
│       ├── capabilities/      # 最小权限 Capability
│       ├── src/db/            # 连接、迁移与 workspace repository
│       └── src/commands/      # typed Tauri 命令
├── docs/                      # 规格、ADR、架构与代理约定
├── scripts/generate-icons.mjs # 应用图标生成脚本
├── Cargo.toml                 # Rust workspace
└── pnpm-workspace.yaml        # JS workspace
```

## 架构边界

- TypeScript 拥有交互与阅读语义:React 工作台、Command Registry、Workspace Store、Repository Interface 与内存 Adapter。
- Rust 拥有持久化与平台完整性:SQLite 连接、迁移、事务与 typed Tauri 命令;TS 不发送任意 SQL,Rust 不理解工作台语义。
- 详细决策见 `docs/adr/`,领域术语见 `CONTEXT.md`。

## 测试策略

- Vitest 覆盖 Command Registry、Workspace Store 与仓库契约;内存 Adapter 与 Tauri Adapter 运行同一份 `workspaceRepositoryContract`。
- Rust 测试在真实 SQLite(内存库)上运行同一契约的镜像断言,覆盖迁移幂等性与损坏数据的领域错误。
- 最高验收 Seam 是 Windows 原生应用,随后续切片扩展;不为 React 内部结构建立脆弱端到端测试。

## 许可证

AI Reader 采用 [AGPL-3.0](LICENSE)。第三方依赖与借鉴来源的许可归属见 [docs/legal/third-party.md](docs/legal/third-party.md)。
