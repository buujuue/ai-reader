# AI Reader — Agent Instructions

本文件是全仓库代理指令的入口与总索引：全局规则在这里，各核心代码目录的具体内容在各自的 `AGENTS.md` 中。

## 沟通约定

- 所有面向用户的回复与项目文档使用中文。
- git 提交信息（commit message）一律使用中文编写。
- 每次回复称呼用户为“老大”。

## 项目概览

AI Reader 是从零构建的独立、轻量、跨端本地阅读器。第一版先跑通类 VS Code 的阅读工作台与 EPUB、PDF、Markdown 阅读链路，不实现 AI、账号、云同步或 OCR。

工单 #1 的底座已落地：`apps/reader` 提供 React + Vite + TypeScript 前端与 Tauri/Rust 平台核心，Windows 原生应用可启动并显示简体中文工作台外壳。新增能力必须复用既有的 Command Registry、Repository Interface 与 typed Tauri 命令边界，不要另起交互或持久化通道。

## AGENTS.md 总索引

| 文件                                | 范围                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| `AGENTS.md`（本文件）             | 全局规则、开发命令、架构边界与总索引                                  |
| `apps/reader/AGENTS.md`           | 阅读器应用：应用级构建与测试命令、前后端分工                          |
| `apps/reader/src/AGENTS.md`       | React + TypeScript 前端：工作台、Command Registry、Repository Adapter |
| `apps/reader/src-tauri/AGENTS.md` | Tauri + Rust 平台核心：SQLite、迁移、typed Command 与 Capability      |
| `scripts/AGENTS.md`               | 仓库级工具脚本                                                        |

- 进入某个目录工作前，先阅读该目录的 `AGENTS.md`。
- 子目录文件只描述本目录的内容与实现细节，不得与本文件的全局规则及 ADR 冲突；冲突时以 ADR 和本文件为准。
- `packages/foliate-js` 等计划中的包记录在 `docs/architecture/overview.md`；在真正创建前，不要把计划结构写成已经存在的结构。

## Agent skills

### Issue tracker

规格与事项使用 GitHub Issues 管理。详见 `docs/agents/issue-tracker.md`。

工单实现完成、验证通过并推送后，必须关闭对应的 GitHub Issue（`gh issue close <编号>`），并在回复中告知老大；无法交付时应保持 OPEN 并说明原因。

### Triage labels

使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human` 和 `wontfix` 五类默认状态。详见 `docs/agents/triage-labels.md`。

### Domain docs

采用单一领域上下文：根目录 `CONTEXT.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。

### UI style

新增、修改或评审任何用户可见界面（页面、组件、布局、色彩、排版、图标、交互状态、响应式、动效与无障碍）前，必须先阅读根目录 `style.md`，并按其中的“UI 任务执行顺序”和“交付检查清单”实施。

`style.md` 是默认视觉与体验规范，不改变产品范围或架构边界；与 `CONTEXT.md`、规格、ADR 或架构文档冲突时以后者为准。`WorkbenchPrototype.tsx` 只提供视觉方向，不得把原型 mock、未来 Agent 占位或绕过 Command/Repository 的行为移入生产代码。

## 重点参考对象：Readest

- [readest/readest](https://github.com/readest/readest) 是本项目最重要的参考实现；本机参考仓库位于 `C:\code\projects\readest`。
- **实现任何功能前，先看 Readest 对应部分是怎么实现的；有能直接复制的代码就直接复制移植，尽量少重复造轮子。** 优先复用 Readest 已验证的阅读逻辑和底层能力，尤其是 `foliate-js` 与 PDF.js 相关实现。
- 直接移植的代码必须登记到 `docs/legal/third-party.md`：来源路径、许可证与署名要求一次写清。
- 每次讨论或决定阅读器行为、模块边界、跨端适配、文件格式支持及工作台架构前，先检查 Readest 的实际代码和架构，再向老大说明它如何实现、哪些部分适合继承，以及轻量化实现准备如何取舍。
- 应用层代码按纵向切片一步步重建，使架构和演进过程可理解；不要机械复制 Readest 的应用层复杂度、无关功能或历史包袱。
- 借鉴不等于兼容：AI Reader 拥有独立品牌、数据格式和升级路径，不承诺迁移或兼容 Readest 用户数据。
- 若参考实现与本仓库已确认的规格或 ADR 冲突，以本仓库的明确决策为准；需要改变既有决策时先新增或修订 ADR。

## 开始工作前

按以下顺序建立上下文：

1. 阅读本文件，以及将要工作的目录对应的 `AGENTS.md`。
2. 阅读 `CONTEXT.md`，使用其中的正式领域术语。
3. 阅读与任务相关的 `docs/adr/` 决策记录。
4. 阅读 `.scratch/reader-foundation/spec.md`，确认需求、验收边界和非目标。
5. 必要时阅读 `docs/architecture/overview.md` 与 `docs/product/vision.md`。
6. 针对将要实现或讨论的部分，检查 Readest 对应源码后再设计或编码；能直接复制的代码直接复制。

## 开发命令

```powershell
# Workspace State owns serialized tabs, editor groups, active views, primary material, and sidebar preference state.
pnpm install                # 安装 JS 依赖(pnpm ≥ 10,Node ≥ 22)
pnpm dev                    # 浏览器降级开发(内存 Repository,无 Tauri)
pnpm tauri dev              # 完整桌面开发(Vite + Tauri)
pnpm build                  # 前端类型检查 + Vite 构建
pnpm tauri build            # 原生应用构建(Windows 为主验收平台)
pnpm test                   # Vitest 全量测试
pnpm typecheck              # TypeScript 严格模式类型检查
pnpm verify:macos           # 校验 macOS 核心阅读冒烟的 Tauri 打包、窗口与权限配置
pnpm verify:ipados          # 校验 iPadOS 核心阅读冒烟的原生配置与工作流步骤
pnpm verify:android         # 校验 Android 平板核心阅读冒烟的原生配置与工作流步骤
pnpm --dir apps/reader test:real-epub-p0 # 真实 Chrome 验证 EPUB 2/3 P0 阅读矩阵
pnpm verify:v1              # 第一版跨端交付静态总验收
cargo test                  # Rust 迁移与 workspace 持久化契约
cargo clippy --workspace --all-targets -- -D warnings
```

JS 依赖以 `pnpm-lock.yaml` 固定，Rust 依赖以 `Cargo.lock` 固定;提交时必须一并提交锁文件变更。

## 架构边界

- TypeScript 拥有交互与阅读语义：React 工作台、Command Registry、Workspace Store、Reader Runtime、`BookDocument`、格式适配、选区与批注锚点、Markdown 编辑会话及 typed Repository Interface。
- Rust 拥有持久化、文件和平台完整性：SQLite、迁移与事务、托管文件、原子替换、完整内容指纹、备份恢复、平台路径与精细 Tauri Command/Capability。
- Rust 不理解 React 焦点、标签布局或选区；TypeScript 不接触数据库表、任意 SQL、数据库路径或文件提交细节。
- EPUB、PDF 与 Markdown 统一通过 `BookDocument` 能力面向上层；外部模块不得直接操纵具体阅读器运行时对象。
- 同一 Editor Group 内每个阅读材料最多对应一个 ReadingView；第一版最多两个 Editor Group，允许同一材料跨组同时打开。再次从书库打开时优先在当前组激活已有标签，不创建同组重复标签。
- 用户意图通过稳定的 Command 表达，已经发生的事实通过 Event 表达。按钮、菜单、键盘和触摸适配器执行同一 Command。
- Workspace State 必须可序列化；Foliate/PDF View、加载任务、当前选区等 Reader Runtime 活对象不得混入持久化状态。每组只保留一个活动渲染器，全应用最多两个。
- 阅读材料一律视为不可信内容。禁止执行书内脚本、加载未经允许的远程资源或把任意文件系统能力暴露给阅读内容。
- 所有导入材料进入托管书库；稳定 `BookId` 与完整内容指纹职责分离。不得仅按标题、作者或文件路径合并资料。
- 普通高亮与批注属于第一版核心领域。EPUB 文本批注必须限制在单一 spine section 内（同章节可跨页、跨栏、跨段，跨章节拒绝保存）；锚点必须版本化、可恢复，状态区分正常/已重锚/失联；无法安全恢复时保留为失联批注，不得静默附着到错误内容。批量恢复通过 Repository 事务提交，普通删除使用 tombstone，恢复不改变原锚点，物理清理只由明确的永久清理流程触发。第一版不实现书签。
- EPUB 内容指纹变化但元数据匹配时，只能进入显式版本迁移候选；不得自动合并。迁移必须先展示进度/批注预览，确认后由 Rust 在同一可恢复提交中替换材料文件、更新工作区与批注，并持续保留迁移前恢复快照；恢复快照只可由用户明确清除。

## 实施规则

- 按 `docs/architecture/overview.md` 的纵向切片顺序推进；先让一个端到端 Seam 可运行，再增加格式和平台。
- 优先在拥有规则的深模块中实现能力，通过窄接口协作，避免跨模块共享内部状态。
- 新增依赖、格式、平台、数据库 schema、公共 Command、Tauri 能力或跨 TS/Rust 接口前，先确认相关 ADR 与 Readest 实现；会改变已确认范围时先征得老大同意。
- 第一版禁止引入 AI、Agent、模型 SDK、向量检索、账号、云同步或 OCR 代码。可以保留清晰边界，但不要创建空包或占位实现。
- 测试应覆盖最高可用应用 Seam，并为 TS Repository 提供内存适配器；TypeScript 内存 Adapter 与 Tauri Adapter 必须运行同一份契约测试，Rust 侧在真实 SQLite 上运行镜像契约。具体命令以“开发命令”一节为准。

## CODEMAP 维护规则

- 每个含源码的 `src/` 目录（含嵌套子目录）都维护一个 `CODEMAP.md`，向人类工程师说明该目录的功能与不同文件夹之间的依赖关系。
- `CODEMAP.md` 应包含：目录功能说明、依赖的其它文件夹、被谁依赖、依赖方向与关键边界。
- 重构、新增或删除模块、调整依赖方向或目录结构时，必须在同一变更中同步更新受影响的 `CODEMAP.md`，确保其与代码一致。

## AGENTS.md 维护规则

本文件是仓库结构和代理工作约定的权威入口与总索引，必须与代码同步演进。发生以下变化时，必须在同一个提交或变更中同步更新：

- 新增、删除或重命名顶层目录、应用、package、crate 或关键模块：更新本文件的索引表，并同步对应子目录的 `AGENTS.md`；新增核心代码目录时必须为其创建 `AGENTS.md`，且不得覆盖已有文件。
- 修改开发入口、构建命令、测试命令或工具链：更新本文件“开发命令”，必要时更新子目录文件。
- 调整 TS/Rust 职责、模块所有权、公共接口或主要数据流：更新本文件“架构边界”和受影响的子目录文件。
- 更换规格、领域文档、ADR 或架构文档的权威路径：更新本文件“文档索引”。

更新时只记录已存在、可验证的路径和命令。架构决策本身变化时，还要同步更新 `docs/architecture/overview.md`，并新增或修订相应 ADR；不要只改本文件。

## 文档索引

- `CONTEXT.md`：领域模型与统一语言。
- `style.md`：项目级 UI 设计风格、交互与无障碍准则；所有 UI 任务的必读路由。
- `docs/product/vision.md`：产品定位、目标与非目标。
- `docs/architecture/overview.md`：总体架构、TS/Rust 分工、模块关系和实施顺序。
- `docs/adr/`：逐项记录已确认的架构决策及理由。
- `docs/agents/`：工程技能使用的事项追踪器、状态标签和领域文档约定。
- `docs/legal/third-party.md`：第三方组件许可与借鉴来源登记。
