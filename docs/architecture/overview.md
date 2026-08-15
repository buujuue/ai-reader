# 架构总览

## 设计原则

1. 先形成可运行的纵向切片，再增加格式与功能。
2. 复用 Readest 已验证的阅读内核，不复制它的应用层耦合。
3. TS 拥有交互与阅读语义；Rust 拥有持久化、文件和平台完整性。
4. 工作区状态可序列化，阅读运行时不可序列化，两者不混存。
5. 用户意图通过 Command，完成事实通过 Event。
6. 所有书籍内容都视为不可信。
7. 同一概念只有一个拥有者，跨 Module 只通过窄 Interface 协作。

## 仓库轮廓

```text
ai-reader/
├── apps/
│   └── reader/
│       ├── src/
│       └── src-tauri/
├── packages/
│   └── foliate-js/
├── docs/
│   ├── adr/
│   ├── architecture/
│   └── product/
├── .scratch/
├── CONTEXT.md
├── Cargo.toml
├── package.json
└── pnpm-workspace.yaml
```

第一阶段不创建空的 AI、同步或 SDK package。Rust 代码先保留在 Tauri crate 中；只有出现第二个真实消费者时才抽取 crate。

## 运行时关系

```text
React Workbench
  ├─ Command Registry
  ├─ Workspace Store（可序列化）
  ├─ Reader Runtime（活对象）
  ├─ Library / Annotation / Markdown Modules
  └─ TypeScript Repository Interfaces
                    │ typed Tauri commands
                    ▼
Rust Application Core
  ├─ SQLite / migrations / transactions
  ├─ managed files / atomic replace / recovery
  ├─ full-content fingerprint
  ├─ backup / restore
  └─ platform paths / permissions / capabilities
```

## TypeScript 职责

- React 工作台、活动栏、侧栏、状态栏、标签和编辑器组。
- Zustand 中的工作区状态、Command Registry 和 Reader Runtime。
- `BookDocument`、Foliate View Adapter、EPUB/PDF/Markdown 阅读语义。
- Markdown 渲染、CodeMirror 编辑会话和保存编排。
- 选择、CFI、批注锚点生成与文档变更后的恢复策略。
- 当前材料搜索、目录、导航历史和输入 Adapter。
- 中文界面、对话框、错误展示和无障碍语义。
- 用 Repository Interface 隔离 Tauri，并提供内存 Adapter 测试。

## Rust 职责

- SQLite 连接、迁移、SQL、事务、外键和一致性检查。
- 托管文件复制、删除、原子替换、暂存与启动恢复。
- 完整内容指纹和文件完整性校验。
- 导入提交、回收站永久删除、备份与恢复。
- 系统路径、文件选择结果接入、权限和平台差异。
- 精细 Tauri Command 与 Capability；不向 TS 暴露任意 SQL 或任意文件系统能力。

Rust 不理解 React 焦点、标签布局和选区；TS 不理解数据库表、SQL、数据库路径和文件提交细节。

## 核心 Module 与 Interface

### Workbench

拥有 Editor Group、ReadingView 描述、活动视图、主要阅读材料和面板期望状态。`primaryMaterialId` 只由显式 `workbench.setPrimaryMaterial` 或“工作区从无材料进入单材料”规则改变；切换标签、Editor Group 或焦点不会修改它。最多两个 Editor Group，持久化左右/上下拆分方向；同一组内每个阅读材料最多对应一个 ReadingView，跨组可以同时打开同一材料。标签激活通过 `reader.activateView` Command 完成，每组的非活动标签保留位置、视口和导航历史等可序列化状态，但释放 Foliate/PDF/加载任务/搜索等活对象。材料更多菜单位于阅读工具栏右侧，仅提供查看/导出材料批注与设置主要阅读材料；材料批注面板由该菜单打开，支持筛选、编辑、导出和经 `annotation.goTo` 跳转；正文高亮不直接打开面板，失联批注继续展示但不猜测位置。`LayoutPolicy` 根据容器宽度计算实际布局，不改写用户期望。

### Command Registry

所有按钮、菜单、键盘和手势执行稳定 Command ID。快捷键只负责按键到 Command 的映射，Event 只表达已经发生的事实。

工作台外壳第一阶段固定使用 C 深色视觉；阅读材料主题仍由 `ReadingTypography` 按全局默认/材料覆盖管理，避免引入第二套外壳主题状态。

正文高亮仍以材料级 Annotation 记录保存，但不注册正文点击打开笔记编辑器的行为；材料批注面板区分仅高亮与带文字笔记，笔记编辑从面板进入。

应用顶栏只注册文件、编辑、视图三组真实菜单 Command，分别覆盖导入/备份/恢复/关闭标签、书库筛选/当前材料搜索、书库/目录/拆分编辑器/阅读排版；不把原型占位动作迁移到生产。

### Library

通过 typed Repository 管理 Reading Material、来源元数据、覆盖值、回收站和封面。读取端只接触领域对象，不接触表结构。

### Import

采用 `stage → inspect → commit`。Rust 暂存并计算指纹；TS 通过 BookDocument 检查格式和元数据；Rust 查重、落库、原子移动并恢复中断状态。

### BookDocument

把 EPUB、PDF、Markdown 统一为目录、章节/页面、搜索、位置和封面能力。外部 Module 不直接操作 Foliate View；所有直接调用集中在 Reader Adapter 内。

### Reader Runtime

按每个 Editor Group 的活动 ReadingView 持有当前 Foliate/PDF View、加载任务、选区和搜索；全应用最多保留两个活动渲染器；按 MaterialId 持有共享的 MarkdownDocumentSession。每组的非活动标签不保留阅读器 Runtime，重新激活时根据 Workspace Store 的可序列化状态重建。

### Annotation

批注是材料级实体。文本锚点包含 CFI、引文、前后文、文档版本和恢复状态；扫描 PDF 使用页码与归一化矩形。恢复失败保留为失联批注。

### Persistence

SQLite 保存材料、批注、阅读位置、工作区和设置。文件系统保存材料、封面、恢复快照与缓存。高频位置写入节流，关键写入使用事务或可恢复协议。

### Markdown

阅读模式复用 BookDocument/Foliate View；源码模式按需加载 CodeMirror 6。同一材料只有一个共享文档缓冲区。正式保存由 Rust 原子替换，之后增加文档版本并恢复锚点。

### Backup

Rust 流式创建包含数据库一致性快照、托管材料和封面的完整包。恢复先将包解到 `stash`
隔离目录，校验 manifest 版本、全部条目指纹、SQLite 完整性和书籍元数据，再检查空间并
为当前书库创建安全快照；切换阶段持久化状态，启动时在打开 SQLite 前回滚中断操作或清理
已完成操作。第一版只做整库替换，不合并两个书库。

## 状态层级

- 全局阅读默认：格式通用的初始阅读偏好。
- 资料级覆盖：该材料所有 View 共享的排版偏好。
- View 级状态：位置、PDF 缩放、Markdown 模式和导航历史。
- Runtime：选区、搜索结果、Foliate 实例、异步任务。

## 响应式工作台

- 宽布局（至少 1200px）：两个 Editor Group，可固定和调整两侧栏。
- 中布局（800–1199px）：可显示两个 Editor Group，但最多固定一个侧栏。
- 紧凑布局（小于 800px）：只显示活动 Editor Group，活动侧栏使用覆盖抽屉；打开阅读材料后抽屉自动收起，隐藏组与面板期望状态不销毁。

布局由 Workbench 容器的 ResizeObserver 驱动。平台只提供安全区、指针类型和系统能力，不负责决定工作台结构。

## 首个纵向切片

Windows 应用启动后，用户可选择本地 EPUB；文件被复制进入托管书库并写入 SQLite；书库显示封面；双击后在标签中打开；用户翻页；位置被保存；关闭并重启应用后，工作区和阅读位置恢复。

这个 Seam 跑通前不加入 PDF、Markdown、批注、第二 Editor Group 或其他平台功能。

## 已落地的纵向切片进度

- **第 1 切片**：Windows 阅读工作区底座（Command Registry、Workspace Repository、typed Tauri 命令边界）。
- **第 2 切片**：托管导入一份 EPUB（stage → inspect → commit、完整内容指纹、SQLite 落库）。
- **第 3 切片**：安全打开 EPUB 并重启续读（`BookDocument`/`EpubBookDocument` + `foliate-js`、`ReadingLocation`、Editor Group 标签、位置节流写入与 flush、重启恢复、内容清洗）。
- **第 4 切片**：批导入并逐文件报告、严格查重并恢复中断导入、书库封面网格、元数据覆盖与回收站（`ImportRepository`、`ReadingMaterial`、指纹去重、`library.trash`/`restoreFromTrash`/`purge`）。书库文件夹树与拖拽归类不属于本次原型迁移，另行切片。
- **第 5 切片**：当前资料目录、搜索、导航历史与基本排版（`TocSidebar`、增量搜索 `searchStore`/`searchRunner`、导航历史后退/前进、阅读排版 `typography.ts` 与 `ReaderSettingsDialog`、排版设置持久化）。
- **第 6 切片**：PDF 固定版式阅读（`pdf/` 子模块：`PdfBookDocument` + `pdfjs-dist`、范围读取并发上限、过期渲染取消、Canvas 内存预算、缩放/页面适配与视口恢复、扫描页无文字层仍显示、`readerSetPdfViewport`/`readerSetPdfFlow` 命令）。对应工单 #14。
- **第 7 切片**：Markdown 安全导入并阅读（`markdown/` 子模块：`marked` 渲染 + `sanitizeHtmlFragment` 清洗、按一级标题分段、内存 EPUB 组装、`MarkdownBookDocument` 复用 Foliate 宿主、标题/作者提取与文件名兜底、`library.openBook` 读取）。对应工单 #17。
- **第 8 切片**：共享编辑 Markdown 并正式保存（按材料唯一的 `MarkdownDocumentSession`、CodeMirror 6 按需加载、`markdown.save`、Rust 原子替换、文档版本与完整指纹更新、脏关闭确认）。对应工单 #18。
- **第 9 切片**：恢复未保存的 Markdown 内容（1 秒节制且按材料串行写入版本化 Recovery Snapshot、Tauri 关闭请求等待 flush、页面隐藏时尽力 flush、无关闭回调的异常终止依靠已落盘周期快照、启动恢复/丢弃、基础版本冲突、损坏与空间不足安全退化、正式保存后清理）。对应工单 #19。
- **第 10 切片**：版本变化后的文本锚点恢复（通过 `BookDocument.search()` 唯一匹配引文与前后文、迁移新 CFI 和文档指纹；歧义或失败时保留为失联批注且不绘制旧高亮）。
- **第 11 切片**：多标签阅读工作区（标签激活与关闭 Command、标签顺序和活动视图持久化、非活动标签释放 Reader Runtime、重启时仅恢复活动标签、缺失材料不阻塞其它标签）。对应工单 #21。
- **第 12 切片**：双 Editor Group 阅读工作区（向右/向下拆分、各组独立活动视图与输入焦点、同材料跨组阅读、最多两个活动渲染器、拆分布局与视图恢复）。对应工单 #22。
- **第 13 切片**：显式主要阅读材料与材料批注面板（主要材料状态与材料操作菜单入口、单材料自动指定、材料级批注筛选、失联标识、EPUB/PDF 批注跳转）。对应工单 #23。
- **第 14 切片**：PDF 文本批注与扫描页区域批注创建（文本选区按所属页生成 PDF 锚点、扫描页显示无文本提示并支持拖拽区域、区域锚点使用页码与归一化矩形、文本/区域创建统一经 Command 持久化）。对应工单 #24。
- **第 15 切片**：完整书库备份导出与恢复（版本化 tar manifest、隔离解包与指纹/SQLite 校验、空间预检、当前库安全快照、可恢复文件切换、启动回滚及前端恢复入口）。对应工单 #25、#26。

macOS 核心阅读冒烟的原生壳配置与证据边界记录在 `docs/architecture/macos-core-smoke.md`；iPadOS 的配置、模拟器启动证据和人工验收步骤记录在 `docs/architecture/ipados-core-smoke.md`；Android 平板的配置、模拟器启动证据和人工验收步骤记录在 `docs/architecture/android-core-smoke.md`。Tauri 使用宿主平台全部打包目标，macOS 最低版本为 12.0，Capability 只向 `main` 窗口授予系统打开/保存对话框和外部 URL 打开权限。真实 macOS/iPadOS/Android 启动、导入、阅读与重启恢复不计入浏览器降级证据，统一由 `.github/workflows/cross-platform.yml` 承载对应平台的自动校验；未能在 CI 自动完成的移动系统交互按冒烟文档记录人工证据。

## 后续切片顺序

1. Markdown 批注锚点迁移。
2. 完整备份、整库恢复和单本批注导出。
3. Android 平板原生启动与核心阅读验收（Tauri Android 配置、模拟器真实 WebView 证据和真机冒烟步骤已落地）。对应工单 #30。

## iPadOS 核心冒烟与验证

iPadOS 原生入口、系统文件选择器、安全区元数据、紧凑容器布局和触摸选区优先级由前端与 Tauri 移动壳共同提供。`.github/workflows/cross-platform.yml` 的 iPadOS job 在 macOS runner 上生成并启动 iPad Simulator 原生应用，上传真实 WebView 启动日志与截图；完整人工验收步骤记录在 `docs/architecture/ipados-core-smoke.md`。

## Android 平板核心冒烟与验证

Android 原生入口、系统文档选择器、最小文件权限、系统返回键、紧凑布局和触摸选区优先级由前端与 Tauri Android 壳共同提供。`.github/workflows/cross-platform.yml` 的 Android job 在 Linux runner 上生成并安装 Android APK，启动平板模拟器真实 WebView，执行触摸与进程重启并上传截图和日志；完整人工验收步骤记录在 `docs/architecture/android-core-smoke.md`。
