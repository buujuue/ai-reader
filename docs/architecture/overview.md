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

拥有 Editor Group、ReadingView 描述、活动视图、主要阅读材料和面板期望状态。最多两个 Editor Group。`LayoutPolicy` 根据容器宽度计算实际布局，不改写用户期望。

### Command Registry

所有按钮、菜单、键盘和手势执行稳定 Command ID。快捷键只负责按键到 Command 的映射，Event 只表达已经发生的事实。

### Library

通过 typed Repository 管理 Reading Material、来源元数据、覆盖值、回收站和封面。读取端只接触领域对象，不接触表结构。

### Import

采用 `stage → inspect → commit`。Rust 暂存并计算指纹；TS 通过 BookDocument 检查格式和元数据；Rust 查重、落库、原子移动并恢复中断状态。

### BookDocument

把 EPUB、PDF、Markdown 统一为目录、章节/页面、搜索、位置和封面能力。外部 Module 不直接操作 Foliate View；所有直接调用集中在 Reader Adapter 内。

### Reader Runtime

按 ReadingView 持有当前 Foliate View、加载任务、选区和搜索；按 MaterialId 持有 MarkdownDocumentSession。最多两个活跃渲染器，即每个可见 Editor Group 一个。

### Annotation

批注是材料级实体。文本锚点包含 CFI、引文、前后文、文档版本和恢复状态；扫描 PDF 使用页码与归一化矩形。恢复失败保留为失联批注。

### Persistence

SQLite 保存材料、批注、阅读位置、工作区和设置。文件系统保存材料、封面、恢复快照与缓存。高频位置写入节流，关键写入使用事务或可恢复协议。

### Markdown

阅读模式复用 BookDocument/Foliate View；源码模式按需加载 CodeMirror 6。同一材料只有一个共享文档缓冲区。正式保存由 Rust 原子替换，之后增加文档版本并恢复锚点。

### Backup

Rust 流式创建包含数据库一致性快照、托管材料和封面的完整包。恢复先验证到暂存区，再原子切换；第一版不合并两个书库。

## 状态层级

- 全局阅读默认：格式通用的初始阅读偏好。
- 资料级覆盖：该材料所有 View 共享的排版偏好。
- View 级状态：位置、PDF 缩放、Markdown 模式和导航历史。
- Runtime：选区、搜索结果、Foliate 实例、异步任务。

## 响应式工作台

- 宽布局（至少 1200px）：两个 Editor Group，可固定和调整两侧栏。
- 中布局（800–1199px）：可显示两个 Editor Group，但最多固定一个侧栏。
- 紧凑布局（小于 800px）：只显示活动 Editor Group，侧栏使用覆盖抽屉；隐藏组状态不销毁。

布局由 Workbench 容器的 ResizeObserver 驱动。平台只提供安全区、指针类型和系统能力，不负责决定工作台结构。

## 首个纵向切片

Windows 应用启动后，用户可选择本地 EPUB；文件被复制进入托管书库并写入 SQLite；书库显示封面；双击后在标签中打开；用户翻页；位置被保存；关闭并重启应用后，工作区和阅读位置恢复。

这个 Seam 跑通前不加入 PDF、Markdown、批注、第二 Editor Group 或其他平台功能。

## 已落地的纵向切片进度

- **第 1 切片**：Windows 阅读工作区底座（Command Registry、Workspace Repository、typed Tauri 命令边界）。
- **第 2 切片**：托管导入一份 EPUB（stage → inspect → commit、完整内容指纹、SQLite 落库）。
- **第 3 切片**：安全打开 EPUB 并重启续读（`BookDocument`/`EpubBookDocument` + `foliate-js`、`ReadingLocation`、Editor Group 标签、位置节流写入与 flush、重启恢复、内容清洗）。
- **第 4 切片**：批导入并逐文件报告、严格查重并恢复中断导入、书库封面、元数据覆盖与回收站（`ImportRepository`、`ReadingMaterial`、指纹去重、`library.trash`/`restoreFromTrash`/`purge`）。
- **第 5 切片**：当前资料目录、搜索、导航历史与基本排版（`TocSidebar`、增量搜索 `searchStore`/`searchRunner`、导航历史后退/前进、阅读排版 `typography.ts` 与 `ReaderSettingsDialog`、排版设置持久化）。

## 后续切片顺序

1. 普通高亮、笔记与文本锚点恢复。
2. PDF 阅读、文本批注和扫描页区域锚点。
3. Markdown 阅读、源码编辑、恢复快照和锚点迁移。
4. 第二 Editor Group、显式主要阅读材料和响应式布局。
5. 完整备份、整库恢复和单本批注导出。
6. macOS、iPadOS、Android 平板原生启动与核心阅读验收。
