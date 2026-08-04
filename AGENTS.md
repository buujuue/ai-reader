# AI Reader — Agent Instructions

## 沟通约定

- 所有面向用户的回复与项目文档使用中文。
- 每次回复称呼用户为“老大”。

## 项目概览

AI Reader 是从零构建的独立、轻量、跨端本地阅读器。第一版先跑通类 VS Code 的阅读工作台与 EPUB、PDF、Markdown 阅读链路，不实现 AI、账号、云同步或 OCR。

工单 #1 的底座已落地：`apps/reader` 提供 React + Vite + TypeScript 前端与 Tauri/Rust 平台核心，Windows 原生应用可启动并显示简体中文工作台外壳。新增能力必须复用既有的 Command Registry、Repository Interface 与 typed Tauri 命令边界，不要另起交互或持久化通道。

## Agent skills

### Issue tracker

规格与事项使用 GitHub Issues 管理。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human` 和 `wontfix` 五类默认状态。详见 `docs/agents/triage-labels.md`。

### Domain docs

采用单一领域上下文：根目录 `CONTEXT.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。

## 重点参考对象：Readest

- [readest/readest](https://github.com/readest/readest) 是本项目最重要的参考实现；本机参考仓库位于 `C:\code\projects\readest`。
- 每次讨论或决定阅读器行为、模块边界、跨端适配、文件格式支持及工作台架构前，先检查 Readest 的实际代码和架构，再向老大说明它如何实现、哪些部分适合继承，以及轻量化实现准备如何取舍。
- 优先复用 Readest 已验证的阅读逻辑和底层能力，尤其是 `foliate-js` 与 PDF.js 相关实现；应用层代码按纵向切片一步步重建，使架构和演进过程可理解。
- 借鉴不等于兼容：AI Reader 拥有独立品牌、数据格式和升级路径，不承诺迁移或兼容 Readest 用户数据。
- 不要机械复制 Readest 的应用层复杂度、无关功能或历史包袱。引用、移植或修改代码时必须核对并遵守上游许可证、版权和署名要求。
- 若参考实现与本仓库已确认的规格或 ADR 冲突，以本仓库的明确决策为准；需要改变既有决策时先新增或修订 ADR。

## 开始工作前

按以下顺序建立上下文：

1. 阅读本文件。
2. 阅读 `CONTEXT.md`，使用其中的正式领域术语。
3. 阅读与任务相关的 `docs/adr/` 决策记录。
4. 阅读 `.scratch/reader-foundation/spec.md`，确认需求、验收边界和非目标。
5. 必要时阅读 `docs/architecture/overview.md` 与 `docs/product/vision.md`。
6. 针对将要实现或讨论的部分，检查 Readest 对应源码后再设计或编码。

## 当前仓库结构

```text
ai-reader/
├── .scratch/
│   └── reader-foundation/spec.md      # 当前基础版完整规格
├── apps/
│   └── reader/                        # 阅读器应用
│       ├── src/                       # React + TypeScript 前端
│       │   ├── app/                   # 入口、bootstrap、AppServices 上下文
│       │   ├── commands/              # Command Registry 与稳定 Command ID
│       │   ├── components/            # 工作台外壳组件
│       │   ├── domain/workspace/      # 工作区状态与 Repository Adapter
│       │   └── workbench/             # Workspace Store 与命令处理
│       └── src-tauri/                 # Tauri + Rust 平台核心
│           ├── capabilities/          # 最小权限 Capability
│           ├── src/db/                # SQLite 连接、迁移、workspace repository
│           └── src/commands/          # typed Tauri 命令
├── docs/
│   ├── agents/                        # 工程技能的事项追踪器与领域文档约定
│   ├── adr/                           # 已确认的架构决策
│   ├── architecture/overview.md       # 总体架构、职责和切片顺序
│   ├── legal/third-party.md           # 第三方许可与来源登记
│   └── product/vision.md              # 产品愿景与范围
├── scripts/generate-icons.mjs         # 应用图标生成脚本
├── CONTEXT.md                         # 领域术语与统一语言
├── LICENSE                            # AGPL-3.0
├── Cargo.toml                         # Rust workspace
└── pnpm-workspace.yaml                # JS workspace
```

`packages/foliate-js` 等计划中的包记录在 `docs/architecture/overview.md`；在真正创建前，不要把计划结构写成已经存在的结构。

## 开发命令

```powershell
pnpm install                # 安装 JS 依赖(pnpm ≥ 10,Node ≥ 22)
pnpm dev                    # 浏览器降级开发(内存 Repository,无 Tauri)
pnpm tauri dev              # 完整桌面开发(Vite + Tauri)
pnpm build                  # 前端类型检查 + Vite 构建
pnpm tauri build            # 原生应用构建(Windows 为主验收平台)
pnpm test                   # Vitest 全量测试
pnpm typecheck              # TypeScript 严格模式类型检查
cargo test                  # Rust 迁移与 workspace 持久化契约
cargo clippy --workspace --all-targets -- -D warnings
```

JS 依赖以 `pnpm-lock.yaml` 固定，Rust 依赖以 `Cargo.lock` 固定;提交时必须一并提交锁文件变更。

## 架构边界

- TypeScript 拥有交互与阅读语义：React 工作台、Command Registry、Workspace Store、Reader Runtime、`BookDocument`、格式适配、选区与批注锚点、Markdown 编辑会话及 typed Repository Interface。
- Rust 拥有持久化、文件和平台完整性：SQLite、迁移与事务、托管文件、原子替换、完整内容指纹、备份恢复、平台路径与精细 Tauri Command/Capability。
- Rust 不理解 React 焦点、标签布局或选区；TypeScript 不接触数据库表、任意 SQL、数据库路径或文件提交细节。
- EPUB、PDF 与 Markdown 统一通过 `BookDocument` 能力面向上层；外部模块不得直接操纵具体阅读器运行时对象。
- 用户意图通过稳定的 Command 表达，已经发生的事实通过 Event 表达。按钮、菜单、键盘和触摸适配器执行同一 Command。
- Workspace State 必须可序列化；Foliate View、加载任务、当前选区等 Reader Runtime 活对象不得混入持久化状态。
- 阅读材料一律视为不可信内容。禁止执行书内脚本、加载未经允许的远程资源或把任意文件系统能力暴露给阅读内容。
- 所有导入材料进入托管书库；稳定 `BookId` 与完整内容指纹职责分离。不得仅按标题、作者或文件路径合并资料。
- 普通高亮与批注属于第一版核心领域。锚点必须版本化、可恢复；无法安全恢复时保留为失联批注，不得静默附着到错误内容。

## 实施规则

- 按 `docs/architecture/overview.md` 的纵向切片顺序推进；先让一个端到端 Seam 可运行，再增加格式和平台。
- 优先在拥有规则的深模块中实现能力，通过窄接口协作，避免跨模块共享内部状态。
- 新增依赖、格式、平台、数据库 schema、公共 Command、Tauri 能力或跨 TS/Rust 接口前，先确认相关 ADR 与 Readest 实现；会改变已确认范围时先征得老大同意。
- 第一版禁止引入 AI、Agent、模型 SDK、向量检索、账号、云同步或 OCR 代码。可以保留清晰边界，但不要创建空包或占位实现。
- 测试应覆盖最高可用应用 Seam，并为 TS Repository 提供内存适配器；TypeScript 内存 Adapter 与 Tauri Adapter 必须运行同一份契约测试，Rust 侧在真实 SQLite 上运行镜像契约。具体命令以“开发命令”一节为准。

## AGENTS.md 维护规则

本文件是仓库结构和代理工作约定的权威入口，必须与代码同步演进。发生以下变化时，必须在同一个提交或变更中更新本文件：

- 新增、删除或重命名顶层目录、应用、package、crate 或关键模块；
- 修改开发入口、构建命令、测试命令或工具链；
- 调整 TS/Rust 职责、模块所有权、公共接口或主要数据流；
- 更换规格、领域文档、ADR 或架构文档的权威路径；
- 新增独立 manifest 管理的子项目。必要时在该子目录创建更具体的 `AGENTS.md`，且不得覆盖已有文件。

更新时只记录已存在、可验证的路径和命令。架构决策本身变化时，还要同步更新 `docs/architecture/overview.md`，并新增或修订相应 ADR；不要只改本文件。

## 文档索引

- `CONTEXT.md`：领域模型与统一语言。
- `.scratch/reader-foundation/spec.md`：第一版完整规格和验收边界。
- `docs/product/vision.md`：产品定位、目标与非目标。
- `docs/architecture/overview.md`：总体架构、TS/Rust 分工、模块关系和实施顺序。
- `docs/adr/`：逐项记录已确认的架构决策及理由。
- `docs/agents/`：工程技能使用的事项追踪器、状态标签和领域文档约定。
- `docs/legal/third-party.md`：第三方组件许可与借鉴来源登记。
