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

拥有 Editor Group、ReadingView 描述、活动视图、主要阅读材料和面板期望状态。`primaryMaterialId` 只由显式 `workbench.setPrimaryMaterial` 或“工作区从无材料进入单材料”规则改变；切换标签、Editor Group 或焦点不会修改它。最多两个 Editor Group，持久化左右/上下拆分方向；同一组内每个阅读材料最多对应一个 ReadingView，跨组可以同时打开同一材料。标签激活通过 `reader.activateView` Command 完成，每组的非活动标签保留位置、视口和导航历史等可序列化状态；已完成的 EPUB/Markdown/PDF Runtime 先按 ADR-0040 进入一个按 ReadingView 身份隔离的挂起槽位，PDF 挂起只保留 PDF.js 文档和当前页的预算内结果，只有未完成、版本失配、失效或超预算时才关闭重建。书库文件夹树的用户展开集合 `expandedLibraryFolderIds` 与位于树下方、回收站上方的未归类区块状态 `unfiledMaterialsExpanded` 同属 Workspace State；书库搜索投影、命中路径和搜索期间的临时展开覆盖只存在于 `PrimarySidebar` 运行时，清空搜索后回到搜索前状态。材料更多菜单位于阅读工具栏右侧，提供查看/导出材料批注、设置主要阅读材料、编辑材料元数据和移入回收站；材料批注面板由该菜单打开，支持筛选、编辑、导出和经 `annotation.goTo` 跳转；正文高亮不直接打开面板，失联批注继续展示但不猜测位置。`LayoutPolicy` 根据容器宽度计算实际布局，不改写用户期望。

### Command Registry

所有按钮、菜单、键盘、触摸和拖放适配器执行稳定 Command ID。快捷键只负责按键到 Command 的映射，Event 只表达已经发生的事实。书库材料拖放只接受单个 `MaterialId` 并与“移动到……”菜单共用 `library.moveMaterial`；拖放不直接修改 Store 或 Repository，目标由 Command 再次按权威文件夹列表校验。PDF 分页模式的正文左右点击/轻触也通过同一组翻页 Command；由于 PDF 内容位于应用顶层文档，监听必须限定在当前 ReadingView 正文容器内，选择、批注区域拖选和交互控件优先。

工作台外壳第一阶段固定使用 C 深色视觉；阅读材料主题仍由 `ReadingTypography` 按全局默认/材料覆盖管理，避免引入第二套外壳主题状态。

正文高亮仍以材料级 Annotation 记录保存，但不注册正文点击打开笔记编辑器的行为；材料批注面板区分仅高亮与带文字笔记，笔记编辑从面板进入。

应用顶栏只注册文件、编辑、视图三组真实菜单 Command，分别覆盖导入/备份/恢复/关闭标签、书库筛选/当前材料搜索、书库/目录/拆分编辑器/阅读排版；不把原型占位动作迁移到生产。

### Library

书库材料可从“移动到……”菜单或桌面拖放快捷方式移动；拖放只传递单个稳定 `MaterialId`，无效载荷、无效 FolderId、当前归属、回收站材料和平台失败均不做乐观 Store 更新。

通过 typed Repository 管理 Reading Material、来源元数据、覆盖值、唯一文件夹归属、回收站和封面。EPUB 来源封面由 foliate-js 在导入检查阶段选择，PDF 来源封面由 PDF.js 渲染首页，再由 TypeScript 生成受控缩略图；自定义封面与来源封面分目录、分字段托管，读取时遵循“自定义优先、来源兜底”。新导入材料的 `folderId` 默认为 null，材料移动只更新唯一归属，不复制或改写材料；回收站与恢复保留归属。文件夹删除经 `library.deleteFolder` 进入 typed Repository，在 Tauri 的同一 SQLite 事务中递归移除文件夹并将活跃/回收站材料置为未归类。书库筛选由 TypeScript 在有效标题、作者和文件夹名称上生成树投影，材料命中保留从未归类/根文件夹到当前归属的完整路径，且临时展开不回写 Workspace State；书库刷新后以权威 FolderId 集合清理恢复载荷中的失效展开 ID，清理持久化失败也不阻塞标签和阅读位置恢复。受管理正文缺失时仍保留领域对象与用户数据，并通过完整指纹重新关联；读取端只接触领域对象，不接触表结构。`ManagedFileSource` 通过稳定 MaterialId 提供只读、File/Blob 兼容的惰性范围来源，格式层不接触 Tauri 协议或托管路径；EPUB、PDF、Markdown 的生产打开边界不再暴露通用完整托管文件读取。PDF 导入检查负责格式/来源元数据/首页封面，已导入 PDF 的阅读 Command 复用有效元数据，首屏挂载时每个 Runtime 只创建一次 PDF.js 文档。

### Import

采用 `stage → inspect → commit`。Rust 暂存并计算完整指纹；TS 通过 BookDocument 检查格式和元数据；Rust 按「完整指纹 + 格式」查重，使用 IMMEDIATE 事务串行化 ready 唯一提交、移动托管副本并恢复中断状态。普通删除将正文移出活跃托管目录但保留在可恢复私有空间与用户数据；相同完整指纹导入原子恢复原 BookId，仅元数据匹配进入显式版本迁移。

### BookDocument

把 EPUB、PDF、Markdown 统一为目录、章节/页面、搜索、位置和封面能力。外部 Module 不直接操作 Foliate View；所有直接调用集中在 Reader Adapter 内。PDF.js 只经并发上限为 6 的 `PDFDataRangeTransport` 读取共享 `ManagedFileSource`，不传入完整 `data`。PDF 滚动模式先建立与页数等长的默认尺寸占位，只有 `IntersectionObserver` 预加载窗口附近的页面才调用 `getPage` 并渲染；页面真实尺寸到达后按当前页内比例恢复滚动锚点，页面加载最多 3 个在途，已渲染页面上限为 12，分页模式仍维持当前页 + 一页前瞻。

### Reader Runtime

按每个 Editor Group 的活动 ReadingView 持有当前 Foliate/PDF View、加载任务、选区和搜索；全应用最多保留两个活动渲染器；按 MaterialId 持有共享的 MarkdownDocumentSession。ADR-0040 替代“所有非活动标签立即释放”的旧约束：EPUB/Markdown/PDF 首次打开完成后可按 ReadingView 身份进入一个有界 `suspended` Runtime 缓存，挂起时只保留已解析对象和预算内的不可见 renderer/当前 PDF 页，不保留输入接线；缓存命中只重新挂载同一 renderer，未完成加载、版本/指纹/算法不一致或超出桌面/平板硬预算时进入 `evicted` 并关闭。Markdown 源码模式进入时同样挂起 Foliate，缓冲区、正式保存、放弃或恢复快照变化会先失效材料的全部 Runtime，再按共享会话文本重建非源码视图。Workspace State 仍只保存位置、视口、模式和历史，完整生命周期与资源预算见 `docs/adr/0040-bounded-reader-runtime-cache.md`。

### Annotation

批注是材料级实体。文本锚点包含 CFI、引文、前后文、文档版本和恢复状态；扫描 PDF 使用页码与归一化矩形。恢复失败保留为失联批注；
EPUB 文本批注限制在单一 spine section 内，跨页/跨栏/跨段允许，跨章节拒绝保存。普通删除使用 tombstone，批量恢复通过事务提交，
显式恢复不改变原锚点。具体决策见 ADR-0025。

### Persistence

SQLite 保存材料、批注、阅读位置、工作区和设置；材料表的 nullable `folder_id` 由外键指向书库文件夹，null 表示未归类，文件夹删除按既有规则转为 null。Workspace State schema 12 同时保存 `expandedLibraryFolderIds` 与 `unfiledMaterialsExpanded`；前者在加载书库权威文件夹列表后裁剪，旧 DTO 缺失后者时默认展开。文件系统分开保存 `covers/` 自定义封面与 `source-covers/` 来源封面，以及材料、恢复快照、版本迁移快照、普通删除的可恢复正文与可再生成缓存。普通删除移除活跃正文路径但保留这些用户数据，永久清理先切断迁移快照再清理记录与全部文件；因此真正缺失正文可明确显示且只能由同完整指纹重新关联。EPUB 缺失原生导航时的临时目录由 TypeScript 按标题推导，缓存由 Rust 经 typed 命令按材料完整指纹与算法版本原子保存，且不进入书库备份或同步边界。高频位置写入节流，关键写入使用事务或可恢复协议；显式 EPUB 版本迁移提交前保存一致的旧数据库与旧托管文件，迁移后快照持续保留。具体目录决策见 ADR-0027。

### Markdown

阅读模式复用 BookDocument/Foliate View；源码模式按需加载 CodeMirror 6。同一材料只有一个共享文档缓冲区。未修改会话可复用挂起的 Foliate Runtime；缓冲区变化、放弃、恢复快照和正式保存先使旧渲染结果失效，返回阅读模式时从最新共享会话安全重建，避免显示过期正文。没有可复用会话时，打开/重建通过 `ManagedFileSource` 按受控分块读取，完整文本只在 Markdown 领域内物化；正式保存由 Rust 原子替换，之后增加文档版本并恢复锚点。增量 Markdown 解析不在当前范围内。

### Backup

Rust 流式创建包含数据库一致性快照、托管材料、来源封面和自定义封面的完整包。恢复先将包解到 `stash`
隔离目录，校验 manifest 版本、全部条目指纹、SQLite 完整性和书籍元数据，再检查空间并
为当前书库创建安全快照；切换阶段持久化状态，启动时在打开 SQLite 前回滚中断操作或清理
已完成操作。当前 manifest v2 还校验书库文件夹的稳定 ID、父子关系、五层限制、材料 `folderId`
和 Workspace State 的树展开引用；v1 旧归档在暂存区移除文件夹数据并让材料进入未归类，保留书籍、封面、设置、位置、批注和标签。第一版只做整库替换，不合并两个书库。

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
- **第 4 切片**：批导入并逐文件报告、严格查重并恢复中断导入、书库封面网格、元数据覆盖与回收站（`ImportRepository`、`ReadingMaterial`、指纹去重、`library.trash`/`restoreFromTrash`/`purge`）。
- **第 5 切片**：当前资料目录、规范搜索、导航历史与基本排版（`TocSidebar`、按章节规范 DOM 增量搜索 `canonicalSearch.ts`/`searchStore`/`searchRunner`、文本/安全正则预算与取消、导航历史后退/前进、阅读排版 `typography.ts` 与 `ReaderSettingsDialog`、排版设置持久化）。
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
- **第 16 切片**：单章节 EPUB 批注完整生命周期（同一 spine section 内跨页/跨栏/跨段选区、跨章节拒绝、已重锚/失联状态、批量恢复事务、批注 tombstone 与显式撤销/恢复）。
- **第 17 切片**：显式 EPUB 版本迁移（元数据仅作候选信号、完整指纹保持材料身份边界、进度/批注预览、同 spine 唯一引文重锚、孤儿保留，以及 SQLite/托管文件/工作区/批注的一次性可恢复提交与持续迁移快照）。
- **第 18 切片**：PDF 范围加载与首屏渲染（导入检查器与阅读文档共享 `ManagedFileSource` 契约，PDF.js 通过最多 6 个并发范围请求按需加载文档信息、首屏与翻页，打开/销毁取消队列）。对应工单 #35，具体决策见 ADR-0030。
- **第 19 切片**：已导入 PDF 单次打开解析（阅读 Command 复用书库有效元数据，首屏挂载阶段每个新建活动 PDF Runtime 只调用一次 PDF.js `getDocument`；结构损坏、范围失败和初始化失败直接转换为中文诊断）。对应工单 #43，具体决策见 ADR-0030。
- **第 20 切片**：Windows 大型 PDF 的 MaterialId 二进制范围协议（Tauri `managed-range` custom URI 由 Rust 校验活跃 ready 材料并返回二进制；Windows PDF 通过 WebView fetch 读取，非 Windows/EPUB/Markdown 保持现有 typed range fallback）。对应工单 #44，具体决策见 ADR-0032。
- **第 21 切片**：窗口化 PDF 滚动布局（滚动模式全页占位、`IntersectionObserver` 视口调度、最近页面优先、最多 3 个在途、最多 12 个已渲染页面、混合尺寸增量修正与阅读位置锚点恢复）；分页模式与 PDF.js 的既有读取/取消/内存边界保持不变。对应工单 #45，具体决策见 ADR-0033。
- **第 22 切片**：书库文件夹树（独立 `LibraryFolderRepository` 的内存/Tauri Adapter 与真实 SQLite 持久化、稳定文件夹 ID、显式父子关系、五层和名称规则、生产树 UI、创建/取消/改名 Command、树展开状态恢复）。对应工单 #47，具体决策见 ADR-0034、ADR-0035、ADR-0036、ADR-0037。
- **第 23 切片**：单本材料归类（`ReadingMaterial.folderId` 与 nullable SQLite 外键、导入默认未归类、文件夹叶子节点与稳定标题排序、“移动到……”菜单、移回未归类、内存/Tauri Repository 契约、回收站恢复保留归属）；完整备份随 SQLite 快照保留归属，文件夹删除继续由既有规则将材料转为未归类。对应工单 #48，具体决策见 ADR-0038。
- **第 24 切片**：安全删除书库文件夹子树（一次明确确认、内存/Tauri `LibraryFolderRepository.deleteFolder` 契约、SQLite 事务内递归删除与活跃/回收站材料转未归类、展开状态清理、失败回滚和打开 ReadingView/用户数据保留）。对应工单 #49，具体决策见 ADR-0035、ADR-0038。
- **第 25 切片**：书库文件夹树搜索与展开状态恢复（同时匹配文件夹/有效标题/作者、命中材料完整路径、祖先自动展开、搜索临时展开隔离与清空恢复；未归类区块位于树下方、回收站上方且其折叠状态持久化；启动清理失效 FolderId；文件夹树键盘与触控语义）。对应工单 #50，具体决策见 ADR-0039。
- **第 26 切片**：单本材料拖放归类快捷方式（桌面精确指针下从材料叶子节点拖到已有文件夹或未归类；与“移动到……”共用 `library.moveMaterial` Command；单材料载荷、无效目标、失败回滚、非拖放输入和重启归属测试）。对应工单 #51，具体决策见 ADR-0038。
- **第 27 切片**：完整书库备份与树型书库总验收（manifest v2 明确保存文件夹/材料归属，恢复前校验树关系、外键和 Workspace 树展开引用；v1 旧备份安全降级为未归类；前端顶栏入口与 Rust 整库切换保持一致）。对应工单 #52，具体决策见 ADR-0037。
- **第 28 切片**：有限活 Reader Runtime 缓存与 EPUB/Markdown A→B→A 真实浏览器基线（active/suspended/evicted/closed 生命周期、按视图与材料内容版本隔离的缓存键、桌面/平板 LRU 硬预算、挂起前 flush 与输入清理）。对应工单 #53，具体决策见 ADR-0040。
- **第 29 切片**：Markdown ReadingView 缓存与编辑一致性（源码模式挂起/恢复 Foliate，按共享会话失效脏渲染结果，正式保存/放弃/Recovery Snapshot 后安全重建，双 Editor Group 保持独立 Runtime，真实 Chrome 脚本覆盖编辑失效与回切）。对应工单 #55，具体决策见 ADR-0040。
- **第 29 切片**：EPUB ReadingView 回切即时恢复（真实标签 Command 切换复用同一 BookDocument/Foliate 宿主，挂起时断开输入与焦点、LRU/材料失效只关闭一次，回收站与整库恢复清理旧 Runtime，并覆盖跨组隔离与缓存命中状态）。对应工单 #54，具体决策见 ADR-0040。
- **第 30 切片**：PDF ReadingView 在内存预算内即时回切（分页/滚动位置与视口恢复、PDF.js 文档代理复用、当前页 Canvas/解码页收缩、范围请求暂停、LRU 淘汰与关闭竞态隔离，并复用大型 PDF 浏览器/Tauri 性能门禁）。对应工单 #56，具体决策见 ADR-0040。
- **第 31 切片**：跨格式有限活 Reader Runtime 总验收（真实 Chrome 通过六组 EPUB/PDF/Markdown 同格式与跨格式 A→B→A；PDF pair 额外执行 A→B→A→B→A，覆盖双 Editor Group、快速切换、PDF 挂起资源、LRU/关闭/重启和 Markdown 编辑生命周期；600 页以上 PDF 与 Windows Tauri `managed-range` 继续由大型 PDF 门禁覆盖）。对应工单 #57，具体决策见 ADR-0040。
- **EPUB 语义与原生回退切片**：foliate-js 是 EPUB 元数据、封面、目录、spine、资源与 CFI 的唯一语义来源；Rust/Tauri 只在 parity gate 通过的平台预取 container/OPF/NAV/NCX 和资源尺寸。原生解析、预取或桥接失败时，必须在创建阅读器前回退到同一份纯 JS ZIP loader，禁止半原生状态、重复对象或位置漂移。具体决策见 ADR-0024。
- **EPUB 缺失导航回退切片**：原生 NAV/NCX 不可导航但正文可读时，按受限标题扫描生成非权威临时目录；无可靠标题时保留空目录并继续阅读，缓存由 Rust 私有文件边界托管。具体决策见 ADR-0027。
- **托管材料范围读取边界**：`ManagedFileSource` 以稳定 MaterialId 对接 Rust 的半开区间读取；TypeScript 侧使用 128 KiB/128 块 LRU 与并发分块去重。Markdown 打开/编辑/重新打开统一使用 Source；PDF 导入检查和阅读均经 `PDFDataRangeTransport` 按需加载，但已导入阅读路径不再先检查后重建 PDF.js 文档；EPUB 检查、打开与资源获取共享 Source，并由惰性 ZIP loader 按需加载。Windows Tauri 的 PDF Source 可通过 `managed-range.localhost` 以 MaterialId + 半开范围接收二进制响应；非 Windows、非 PDF 和浏览器降级继续使用现有受控范围回退，Windows 协议授权或读取失败则直接报告可诊断错误，禁止路径暴露或静默全量读取。具体决策见 ADR-0028、ADR-0029、ADR-0030、ADR-0031 与 ADR-0032。
- **阅读读取性能验收**：`apps/reader/scripts/verify-reading-performance.mjs` 默认在真实 Chrome 中运行三次浏览器直接 `File` 基线和完整 `library.openBook → mountViewDocument → ManagedFileSource → BookDocument` 路径；PDF 夹具为 640 页、每页 16 KiB 被引用内容流、超过 8 MiB，不依赖未引用尾部填充。脚本记录首次有效 Canvas 且文字层/无文字状态收敛的耗时、PDF.js 解析轮次、页面对象轮次、范围请求、累计读取、峰值 JS 内存和滚动活跃 Canvas，并验证单次打开只创建一份 PDF.js 文档、范围不超过 8 MiB、累计读取不超过文件大小的 110%、滚动窗口不超过 12 个 Canvas。通过 `READING_PERFORMANCE_MODE=tauri`、WebView2 远程调试地址和显式 `READING_PERFORMANCE_PDF_PATH`，同一脚本连接 Windows Tauri 生产 WebView，要求使用 `managed-range` 二进制响应且首屏中位数不超过浏览器 File 基线 2 倍；报告与失败诊断均脱敏并在 finally 清理浏览器、Vite、样本服务器和阅读运行时。
- **Reader Runtime 缓存总验收（Issue #57）**：`apps/reader/scripts/verify-reader-runtime-cache.mjs` 在真实 Chrome 中通过真实 `library.openBook`/`reader.activateView` 与 Markdown Command 构造 EPUB、PDF、Markdown，覆盖 EPUB↔EPUB、Markdown↔Markdown、PDF↔PDF 及三组跨格式 A→B→A；PDF pair 额外执行 A→B→A→B→A。默认五轮记录切出、首次可见、回切首次可交互、缓存命中、BookDocument 来源打开、Foliate renderer/PDF.js 文档创建、范围读取、PDF 挂起 Canvas/解码页/在途范围读取、双 Editor Group、源码编辑/保存/恢复快照/重启和 LRU 退化。每轮用同机冷回切中位数/P95 作为动态门槛，要求命中不新建对象或读取范围且命中中位数/P95 不超过冷路径；报告写入 `apps/reader/scripts/artifacts/reader-runtime-cache.json`，具体预算与失效规则见 ADR-0040。600 页以上 PDF 读取与 Windows `managed-range` 二进制门禁继续由 `verify-reading-performance.mjs` 负责。

macOS 核心阅读冒烟的原生壳配置与证据边界记录在 `docs/architecture/macos-core-smoke.md`；iPadOS 的配置、模拟器启动证据和人工验收步骤记录在 `docs/architecture/ipados-core-smoke.md`；Android 平板的配置、模拟器启动证据和人工验收步骤记录在 `docs/architecture/android-core-smoke.md`。Tauri 使用宿主平台全部打包目标，macOS 最低版本为 12.0，Capability 只向 `main` 窗口授予系统打开/保存对话框和外部 URL 打开权限。真实 macOS/iPadOS/Android 启动、导入、阅读与重启恢复不计入浏览器降级证据，统一由 `.github/workflows/cross-platform.yml` 承载对应平台的自动校验；未能在 CI 自动完成的移动系统交互按冒烟文档记录人工证据。

## 后续切片顺序

1. Markdown 批注锚点迁移。

## iPadOS 核心冒烟与验证

工单 #56 的 PDF Runtime 缓存验收复用 `apps/reader/scripts/verify-reading-performance.mjs` 的 600 页以上结构型夹具：浏览器与 Windows Tauri 均验证 PDF A→B→A 命中不重复创建 PDF.js 文档或读取范围，分页/滚动位置与视口恢复、挂起资源收缩、LRU 淘汰和退出清理，并记录回切首次可见、解析轮次、范围读取、峰值内存和活跃 Canvas。

iPadOS 原生入口、系统文件选择器、安全区元数据、紧凑容器布局和触摸选区优先级由前端与 Tauri 移动壳共同提供。`.github/workflows/cross-platform.yml` 的 iPadOS job 在 macOS runner 上生成并启动 iPad Simulator 原生应用，上传真实 WebView 启动日志与截图；完整人工验收步骤记录在 `docs/architecture/ipados-core-smoke.md`。

## Android 平板核心冒烟与验证

Android 原生入口、系统文档选择器、最小文件权限、系统返回键、紧凑布局和触摸选区优先级由前端与 Tauri Android 壳共同提供。`.github/workflows/cross-platform.yml` 的 Android job 在 Linux runner 上生成并安装 Android APK，启动平板模拟器真实 WebView，执行触摸与进程重启并上传截图和日志；完整人工验收步骤记录在 `docs/architecture/android-core-smoke.md`。
