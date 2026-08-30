# AI Reader 跨端阅读器基础版规格

Status: ready-for-agent

## Problem Statement

现有 Readest 功能成熟，但项目已经同时承载阅读、账户、同步、在线服务、AI、TTS、翻译、词典与大量平台适配。继续在其应用层上二次开发会带来过高的理解成本、构建重量、状态耦合和维护风险，也不利于逐步理解一个跨端阅读器如何从领域模型、文件导入、渲染、工作区和持久化一路建立起来。

用户需要在全新项目中从零构建一个更轻的独立产品，同时继承此前形成的长期 AI 伴读产品方向。第一版必须刻意排除 AI，先把稳定的跨 Windows、macOS、iPadOS 和 Android 平板阅读工作区跑通。设计与代码应大量借鉴 Readest 已验证的实现，但每一步都应有清晰的 Module、Interface、数据所有权和测试 Seam，而不是整仓复制后继续裁剪。

## Solution

在空仓库中建立 React、Vite、TypeScript 与 Tauri/Rust 组成的跨端阅读器。选择性引入 Readest 的 `foliate-js` 分支与 PDF.js，把 EPUB、PDF、Markdown 统一成 `BookDocument`；用类 VS Code 的单窗口工作台承载标签和最多两个 Editor Group；用 Rust 统一管理 SQLite、托管文件、完整内容指纹、可恢复导入、原子保存与备份恢复。

第一版以本地阅读为完整闭环：用户导入并管理阅读材料，打开多个视图，搜索当前材料，阅读和导航，创建普通高亮与批注，编辑 Markdown，重启后恢复工作区和位置，并能完整备份自己的书籍与批注。AI、账户和同步作为后续阶段约束被记录，但不进入当前依赖、数据流或用户界面。

## User Stories

1. As a 学习者, I want 从系统文件选择器导入 EPUB, so that 我能开始阅读本地电子书。
2. As a 学习者, I want 导入 PDF, so that 我能阅读排版固定的资料。
3. As a 学习者, I want 导入 Markdown, so that 我的文本笔记也能成为一等阅读材料。
4. As a 学习者, I want 一次选择多个文件, so that 我能高效建立书库。
5. As a 学习者, I want 看到每个文件的导入结果, so that 一本损坏的资料不会掩盖其他成功导入。
6. As a 学习者, I want 导入的文件被复制到应用托管空间, so that 外部原文件移动后仍可阅读。
7. As a 学习者, I want 应用永不修改或删除外部原文件, so that 我的个人资料安全。
8. As a 学习者, I want 相同内容只保留一份, so that 书库和存储不会出现无意义重复。
9. As a 学习者, I want 不同内容即使标题作者相同也分别导入, so that 修订版和不同版本不会被错误合并。
10. As a 学习者, I want 重新导入回收站中的相同资料时恢复原记录, so that 我的批注和位置不会丢失。
11. As a 学习者, I want 明确知道文件不支持、已损坏、为空、无权限或空间不足, so that 我能采取正确措施。
12. As a 学习者, I want 应用崩溃后不出现半本书或半条记录, so that 书库始终可信。
13. As a 学习者, I want 在封面书库中浏览阅读材料, so that 我能直观找到想读的内容。
14. As a 学习者, I want 按标题和作者筛选书库, so that 资料多时仍能快速定位。
15. As a 学习者, I want 修改资料的显示标题和作者, so that 元数据不规范的文件仍易于整理。
16. As a 学习者, I want 更换或移除自定义封面, so that 书库视觉信息准确。
17. As a 学习者, I want 一键恢复资料原始元数据, so that 我能撤销自己的整理结果。
18. As a 学习者, I want 元数据整理不改写 EPUB、PDF 或 Markdown, so that 内容身份和批注锚点保持稳定。
19. As a 学习者, I want 把资料移入应用内回收站, so that 误删后可以恢复。
20. As a 学习者, I want 手动永久删除回收站内容, so that 我可以释放存储空间。
21. As a 学习者, I want 永久删除前得到明确二次确认, so that 不会轻易丢失书籍和批注。
22. As a 学习者, I want 在一个应用窗口内打开多个资料标签, so that 我能像使用编辑器一样切换阅读任务。
23. As a 学习者, I want 将标签向右或向下拆分, so that 我能并排对照阅读。
24. As a 学习者, I want 每个 Editor Group 容纳多个标签, so that 分栏数量保持克制但阅读任务不受限制。
25. As a 学习者, I want 同一阅读材料在两个组中同时打开, so that 我能比较同一本书的不同位置。
26. As a 学习者, I want 两个 ReadingView 保持各自阅读位置, so that 一侧翻页不会打断另一侧。
27. As a 学习者, I want 显式指定主要阅读材料, so that 材料批注面板和未来 Agent 的归属稳定。
28. As a 学习者, I want 切换焦点时主要阅读材料保持不变, so that 界面焦点不会偷偷改变语义。
29. As a 学习者, I want 单本打开时自动成为主要阅读材料, so that 常见场景不需要额外操作。
30. As a 学习者, I want 重启后恢复标签、分组、活动视图和侧栏, so that 阅读工作流可以继续。
31. As a 学习者, I want 窄窗口只暂时隐藏第二组而不删除它, so that iPad 分屏和窗口缩放不会破坏工作区。
32. As a 学习者, I want 宽屏可固定并调整左右侧栏, so that 我能按自己的阅读习惯安排空间。
33. As a 学习者, I want 平板窄屏以抽屉方式打开侧栏, so that 正文保持足够宽度。
34. As a 学习者, I want 阅读 EPUB 目录并跳转章节, so that 我能理解并浏览书籍结构。
35. As a 学习者, I want 调整 EPUB 字体、字号、行距、页边距、主题和滚动/分页模式, so that 阅读排版适合自己。
36. As a 学习者, I want 同一本 EPUB 的多个视图共享排版设置, so that 资料呈现保持一致。
37. As a 学习者, I want PDF 保留页面布局并支持翻页和滚动, so that 文档不会被错误重排。
38. As a 学习者, I want 独立调整每个 PDF View 的缩放和适配模式, so that 并排比较时两侧可以采用不同视野。
39. As a 学习者, I want PDF 自带文本层时能够选择文本, so that 我能复制、搜索和批注。
40. As a 学习者, I want 扫描 PDF 即使没有文字层也能正常显示, so that 图片型资料仍可阅读。
41. As a 学习者, I want 扫描页无文字层时保持干净且不出现遮挡阅读内容的提示浮层, so that 我仍可正常阅读并通过框选区域创建页内批注。
42. As a 学习者, I want 在扫描 PDF 上框选区域并添加页内批注, so that 无 OCR 时仍能做手工标记。
43. As a 学习者, I want Markdown 以安全渲染后的阅读模式打开, so that 文本拥有统一阅读体验。
44. As a 学习者, I want 切换 Markdown 源码模式, so that 我能直接维护内容。
45. As a 学习者, I want 使用 Markdown 高亮、撤销重做和查找替换, so that 编辑体验可靠但不过度复杂。
46. As a 学习者, I want 同一 Markdown 双开时共享未保存缓冲区, so that 两侧不会产生互相覆盖的版本。
47. As a 学习者, I want 使用 Ctrl+S 手动正式保存 Markdown, so that 我能控制何时改变文档版本。
48. As a 学习者, I want 崩溃后恢复未保存 Markdown, so that 移动系统强制终止应用时工作不会消失。
49. As a 学习者, I want 关闭脏文档时选择保存、放弃或取消, so that 未保存修改不会静默丢失。
50. As a 学习者, I want Markdown 保存后自动重新生成阅读视图, so that 渲染内容与源码一致。
51. As a 学习者, I want 在当前激活材料内搜索正文, so that 我能快速找到关键词。
52. As a 学习者, I want 搜索过程中逐步看到结果和进度并可取消, so that 大文档搜索不会冻结界面。
53. As a 学习者, I want Ctrl+F 始终作用于当前激活 ReadingView, so that 双栏搜索目标不会含糊。
54. As a 学习者, I want 点击搜索结果跳转并标记对应文本, so that 我能确认命中上下文。
55. As a 学习者, I want 在当前资料的批注中筛选文本, so that 我能定位自己的阅读记录。
56. As a 学习者, I want 目录、链接、搜索和批注跳转支持后退/前进, so that 我能回到跳转前的阅读位置。
57. As a 学习者, I want 普通翻页不污染跳转历史, so that 后退操作仍有意义。
58. As a 学习者, I want 导航历史在标签失活和应用重启后保留, so that 阅读上下文不会因资源释放而消失。
59. As a 学习者, I want 选择一段 EPUB、PDF 或 Markdown 文本并高亮, so that 我能标记重要内容。
60. As a 学习者, I want 为高亮添加或编辑文字笔记, so that 我能记录自己的理解。
61. As a 学习者, I want 批注归属于阅读材料而不是某个 View, so that 同一本书双开时两侧看到同一批注集合。
62. As a 学习者, I want Markdown 修改后批注尽量重新定位, so that 编辑正文不会轻易破坏阅读记录。
63. As a 学习者, I want 无法唯一恢复的批注被标为失联并继续保留, so that 系统不会把批注静默贴错位置。
64. As a 学习者, I want 点击批注跳转到原文, so that 笔记与阅读内容保持连接。
65. As a 学习者, I want 使用键盘方向键和 PageUp/PageDown 阅读, so that 桌面操作高效。
66. As a 学习者, I want 鼠标滚轮在分页模式下一次手势最多翻一页, so that 触控板惯性不会连续误翻。
67. As a 学习者, I want 点击或轻触左右区域翻页, so that 鼠标和触摸操作自然。
68. As a 学习者, I want 水平滑动翻页、垂直滑动滚动, so that 平板手势符合模式预期。
69. As a 学习者, I want 文本选择优先于翻页手势, so that 创建高亮时不会意外换页。
70. As a 学习者, I want 书籍脚本永不执行, so that 本地不可信文件不能取得应用能力。
71. As a 学习者, I want 书籍默认不能加载远程图片、字体或页面, so that 打开文件不会泄露网络信息。
72. As a 学习者, I want 外部链接显示目标并由系统浏览器打开, so that 阅读 WebView 不会导航到不可信网站。
73. As a 学习者, I want 导出完整书库备份, so that 没有云同步时仍能保护数据。
74. As a 学习者, I want 备份包含书籍、封面、设置、位置和批注, so that 恢复后资料可直接继续使用。
75. As a 学习者, I want 恢复前校验备份和所需空间, so that 损坏包不会破坏现有书库。
76. As a 学习者, I want 整库恢复失败时继续使用原书库, so that 恢复操作不会造成双重损失。
77. As a 学习者, I want 导出单本资料的批注为 Markdown, so that 阅读成果不被锁在应用中。
78. As a Windows 用户, I want 首个纵向切片覆盖导入、阅读、重启恢复, so that 核心闭环尽早可验证。
79. As a macOS 用户, I want 应用能原生启动并完成核心阅读冒烟流程, so that 后续完整适配有可靠基线。
80. As an iPadOS 用户, I want 应用适配安全区、触摸和系统分屏, so that 平板阅读可用。
81. As an Android 平板用户, I want 应用适配文件权限、返回行为和触摸阅读, so that 核心流程跨端一致。
82. As a 学习者, I want 界面全部使用简体中文, so that 第一版无需承担多语言维护成本。
83. As a 维护者, I want 每个用户意图拥有稳定 Command ID, so that 按钮、菜单、快捷键和手势不会实现四套逻辑。
84. As a 维护者, I want TS 不发送任意 SQL, so that 数据库迁移和完整性集中由 Rust 管理。
85. As a 维护者, I want Rust 不理解 React 标签和焦点, so that平台核心与界面状态保持解耦。
86. As a 维护者, I want 只为可见组保留活动渲染器并对 EPUB/Markdown 使用有限挂起缓存, so that 多标签不会无界占用 PDF Canvas 和 WebView 内存。
87. As a 维护者, I want 依赖使用锁文件固定且避免无必要 Fork, so that 新项目的供应链和升级成本可控。
88. As a 维护者, I want 通过 ADR 记录每个重要 Seam 和取舍, so that 项目可以作为可理解的架构学习过程演进。
89. As a 后续产品设计者, I want 主要阅读材料与焦点分离, so that 未来书籍 Agent 的归属不会随点击漂移。
90. As a 后续产品设计者, I want Markdown 成为一等阅读材料, so that 未来 AI 笔记无需发明第二种文档系统。
91. As a 后续产品设计者, I want Agent Runtime 与阅读器通过窄 Interface 隔离, so that 第一版无 AI 也不需要预装 AI SDK。
92. As a 后续产品设计者, I want 阅读领域对象拥有稳定身份和可恢复锚点, so that 未来知识包和端到端加密同步有可靠引用基础。

## Implementation Decisions

- 项目是全新独立产品，不从 Readest main 建分支，不承诺兼容 Readest 安装、账户或数据。
- 许可证采用 AGPL-3.0；复用代码时保留来源与第三方许可。`foliate-js` 依据其 MIT 许可，PDF.js 依据 Apache 许可。
- 目标平台为 Windows、macOS、iPadOS 和 Android 平板；不承诺手机、Linux 或完整 Web。
- Windows 是主要开发、讲解和完整应用验收平台；其他三端从第一天保持编译兼容并逐步增加原生冒烟验证。
- 前端采用 React、Vite、TypeScript、Zustand、Tailwind、Radix primitives 和 Lucide；不采用 Next.js、daisyUI 或多套图标库。
- 第一版仅简体中文，不建立 i18n Interface。
- Rust 与 TypeScript 的职责按数据完整性和交互语义划分，而不是按“性能代码/业务代码”粗略划分。
- Rust 独占 SQLite 连接、迁移、SQL 和事务；TS 只调用 typed repository commands，不存在任意 SQL bridge。
- TS Repository Interface 必须有内存 Adapter，以便不启动 Tauri 就能测试工作区与领域流程。
- SQLite 保存阅读材料、批注、位置、工作区和设置；托管文件、封面、恢复快照和缓存位于文件系统。
- 高频阅读位置使用节流写入；批注、回收站、导入提交和正式 Markdown 保存使用事务或可恢复协议。
- 阅读材料以稳定 UUID `BookId` 作为身份；完整内容指纹只用于查重与完整性，不用元数据自动合并版本。
- 所有 EPUB、PDF、Markdown 导入后复制到应用私有托管书库；外部原始文件永不被修改或删除。
- 导入采用 Rust 暂存、TS 检查、Rust 提交的两阶段协议；启动恢复器处理 `pending` 记录与暂存目录。
- 活跃库中相同完整指纹返回既有材料；回收站中相同指纹恢复原 `BookId`；元数据相同但内容不同始终新建。
- 删除采用应用内部回收站；普通删除保留材料、封面、批注、位置和设置；永久删除才级联清理，且第一版不自动清空。
- 来源元数据与用户覆盖值分离；第一版只允许覆盖标题、作者和封面，不把整理结果写回阅读文件。
- `BookDocument` 统一 EPUB、PDF、Markdown 的元数据、目录、章节/页面、搜索、位置、链接和封面能力。
- `foliate-js` 是初始唯一固定来源依赖，沿用 Readest 分支中的必要 PDF/跨端修复；外部 Module 不直接操作 Foliate View。
- PDF 通过 PDF.js Canvas 与 text layer 渲染；没有文字层的扫描页可阅读并支持页码加归一化矩形区域批注，但不提供 OCR。
- Markdown 通过 Marked、HTML 清洗和按一级标题分段构建内存 BookDocument；源码模式使用按需加载的 CodeMirror 6。
- 同一 Markdown 材料按 MaterialId 只有一个 `MarkdownDocumentSession`；多个 View 共享缓冲区。
- Markdown 正文手动正式保存；编辑期间自动写恢复快照。正式保存由 Rust 原子替换文件，递增文档版本、更新指纹并触发锚点恢复。
- Workbench 集中拥有最多两个 Editor Group、标签顺序、活动 View、主要阅读材料和面板期望状态。
- 同一 Editor Group 内每种材料最多拥有一个 ReadingView；跨组允许同时打开同一材料，位置与导航历史按视图保留，资料级批注和排版覆盖按材料共享。
- 主要阅读材料由用户显式指定；单材料时自动指定，焦点切换不改变它。
- 只挂载每个可见 Editor Group 的活动 ReadingView；已完成的 EPUB/Markdown 失活标签可按 ReadingView 身份进入有界 `suspended` Reader Runtime 缓存，挂起前 flush 位置并清理选区、搜索任务、输入焦点和临时覆盖层；PDF、未完成加载、版本/指纹/算法不一致或超出桌面/平板预算时进入 `evicted` 并关闭。Workspace State 仍完全可序列化。具体替代决策见 ADR-0040。
- 工作台由活动栏、主侧栏、中央 Editor Group 和状态栏组成。主要阅读材料的批注通过材料操作菜单打开覆盖式批注面板；右侧栏保留给未来 Agent，第一版不显示 Agent 占位。
- 材料更多菜单位于阅读工具栏右侧，提供查看/导出该材料批注、设置主要阅读材料、编辑元数据和移入回收站；阅读排版沿用阅读设置入口。
- 工作台外壳第一阶段固定采用 C 深色视觉；阅读材料的浅色、羊皮和深色主题仍由现有阅读排版设置单独控制，不新增工作台主题持久化状态。
- 应用顶栏只提供文件、编辑、视图三组真实菜单：导入/备份/恢复/关闭标签、书库筛选/当前材料搜索、书库/目录/拆分编辑器/阅读排版；所有菜单项执行稳定 Command，不保留原型占位动作。
- 选区执行“高亮”仍创建材料级高亮记录，但正文高亮不可点击打开笔记；材料批注面板区分“仅高亮”和“带文字笔记”，笔记编辑只从面板进入。
- 书库树中的单本材料可在桌面精确指针下拖到任意已有文件夹或底部“未归类”，拖放与“移动到……”菜单共用 `library.moveMaterial` Command；只接受单本材料，不允许文件夹、多本材料、回收站材料或无效目标，平板和键盘继续使用菜单。有效、同归属和无效目标以非纯颜色反馈区分，完成/取消时清理临时状态，平台失败时保留原显示并通过应用测试覆盖目标、回滚与重启归属。
- 书库主侧栏默认使用真实、可持久化的书库文件夹树；文件夹拥有稳定 ID 和显式父级，最多五层，同一父级名称不区分大小写唯一，名称自动去除首尾空格并拒绝空值、路径分隔符、控制字符和超过 80 个字符。新建支持顶层/子文件夹，创建后立即命名，Enter 保存、Escape 取消；改名保持父级不变，不提供移动文件夹。阅读材料作为所属文件夹的叶子节点，未归类材料在文件夹树下方、回收站上方以独立可折叠区块展示并显示数量；新导入材料默认未归类，单本材料可经“移动到……”菜单归入任意已有文件夹或移回未归类。删除文件夹前必须一次明确确认；确认后递归删除目标及全部后代，子树结构不可恢复，但活跃和回收站材料均转为未归类，正文、元数据、批注、阅读位置、打开的 ReadingView 和其它侧栏状态保留；取消、数据库失败或约束失败不改变结构和材料归属。材料按有效标题稳定排序，未归类区域有书时默认展开且允许折叠，没有书时只保留轻量标题；筛选同时匹配文件夹名称、标题和作者，命中材料显示完整文件夹路径并自动展开祖先；搜索产生的临时展开在清空/取消后恢复，不能写入持久状态。文件夹展开状态和未归类折叠状态进入可序列化 Workspace State，恢复时安全忽略不存在的 FolderId；文件夹树提供 tree/treeitem/group 语义、方向键、Home/End、Enter/Space、可见焦点和 Escape，未归类与回收站区块使用独立的可访问折叠按钮。继续保留导入、打开、元数据编辑、回收站和封面网格能力。
- 完整书库备份使用版本化 tar manifest 与 SQLite 一致快照；v2 明确记录文件夹稳定 ID、父子关系和材料唯一 `folderId`，Workspace State 中的树展开状态随同一快照保存。恢复先在 `stash` 暂存区校验 manifest、文件指纹、SQLite、文件夹层级、材料归属和展开状态引用，再为当前书库创建安全快照并原子切换；v1 旧备份没有文件夹数据时统一恢复为未归类，书籍、封面、设置、位置、批注和标签不得丢失；任何失败都继续使用原书库并返回中文诊断。
- `LayoutPolicy` 按 Workbench 容器宽度而非设备 UA 决定布局；宽、中、紧凑阈值分别为至少 1200、800–1199 和小于 800 CSS 像素。
- 用户持久化的是面板期望状态；窄布局只改变有效呈现，变宽后恢复原固定状态。
- 宽布局允许活动面板与阅读区并列；中布局最多固定一个侧栏并可覆盖阅读区；紧凑布局将活动面板改为覆盖抽屉，打开材料后自动收起，但不销毁面板或编辑器组状态。
- 全局阅读默认、资料级排版覆盖和 ReadingView 视口状态是三个不同层级。
- 当前材料搜索由激活 ReadingView 执行，支持普通文本、大小写开关、异步增量、取消和跳转；不建立全书库正文索引。
- 每个 ReadingView 保存最多 50 个导航历史位置；普通翻页只替换当前节点，显式跳转才新增节点。
- 所有用户意图使用稳定 Command ID；按钮、菜单、命令面板、快捷键和手势只通过 Command 执行。Event 只描述完成事实。
- 第一版输入包括键盘翻页、分页模式滚轮手势、左右点击/轻触、水平滑动和滚动模式原生垂直滚动；不做卷页截图动画、亮度手势和中键自动滚动。
- 文本批注锚点保存 CFI、选中文字、前文、后文、文档版本与恢复状态。恢复顺序为原 CFI、唯一引文上下文，最后标记失联。
- 扫描 PDF 区域锚点语义上保存页码和归一化矩形；第一版兼容传输层以 `pdf-text:` 编码承载它，加载时不得按文本引文恢复，版本变化后保留为失联批注。
- 所有书籍内容视为不可信。第一版永久禁用书籍脚本、iframe、对象嵌入和主动远程资源；外部链接必须交给系统浏览器。
- Reader Runtime 生命周期分为 `active`、`suspended`、`evicted`、`closed`；缓存只准入 EPUB/Markdown，键包含 ReadingView 身份、MaterialId、完整内容指纹、Markdown 文档版本、解析/清洗算法版本和缓存算法版本。桌面/平板使用独立的活 Runtime、iframe、Canvas、解码页、范围缓存和估算资源硬预算，并按 LRU 淘汰挂起对象；性能门槛从同机冷回切测量动态派生，不写死绝对毫秒数。对应 ADR-0040。
- Tauri CSP 和 Capability 使用最小白名单；前端没有任意文件系统、Shell 或 SQL 能力。
- 上游 Tauri、官方插件和普通 Rust crate 使用锁文件固定；不 vendoring Tauri、tao 或 swift-rs。只有可复现问题且无上游解法时才建立带 ADR 的最小 Patch/Fork。
- 完整备份包含版本化 manifest、SQLite 一致快照、托管材料与封面；流式生成且第一版不加密。
- 恢复采用校验、暂存、安全快照和原子切换；第一版只做整库恢复，不合并两个书库。
- 单本批注可导出为人类可读 Markdown，但不承担完整恢复。
- 后续 AI Runtime 必须可替换，不得把具体 SDK 类型泄漏进 Reader；未来 AI 笔记复用 Markdown Reading Material。
- 后续书籍知识采用书籍索引、章节知识笔记和原文章节片段三层渐进披露，初始不依赖向量 RAG。
- 后续同步坚持端到端加密、可替换后端和本地优先；验证不通过就延期，不允许降级为服务端明文。

## Testing Decisions

- 测试应验证用户可观察行为和稳定 Interface，不断言 React 内部组件结构、Zustand 实现细节或 SQL 文本。
- 最高验收 Seam 是 Windows Tauri 应用：导入本地材料、进入书库、打开标签、阅读、创建高亮、关闭应用并重启恢复。
- 每个纵向切片都扩展同一条应用级验收路径，而不是为每个小组件建立脆弱 E2E。
- Rust 单元与集成测试覆盖迁移、typed repository、外键、导入恢复状态机、流式指纹、原子文件替换、回收站、永久删除、备份与恢复。
- Vitest 覆盖 Workbench reducer/store、Command Registry、LayoutPolicy、材料身份规则、有效元数据合并、导航历史、锚点恢复和 Markdown 会话。
- Vitest Browser 使用真实 `foliate-js` 与浏览器 DOM 验证 EPUB、PDF、Markdown 的打开、位置、目录、搜索、选择和批注覆盖层。
- PDF 测试覆盖 text layer、扫描页无文本状态、范围读取、Canvas 内存上限和两个活跃 View。
- Markdown 测试覆盖渲染清洗、共享缓冲区、恢复快照、原子保存、文档版本递增和失联批注。
- Import Repository 的契约测试必须覆盖新增、已存在、回收站恢复、损坏、取消、磁盘错误以及崩溃后的 pending 恢复。
- TypeScript 的内存 Repository Adapter 与 Rust Tauri Adapter 运行同一组领域契约测试。
- Windows 承担完整应用验收；macOS、iPadOS、Android 平板在第一版至少完成原生启动、文件选择、导入、打开、核心阅读和位置恢复冒烟测试。
- 浏览器设备模拟只用于布局反馈，不能替代 iPadOS 或 Android 原生 WebView 证据。
- 安全测试使用带脚本、危险 URL、远程资源和嵌入对象的恶意 EPUB/Markdown fixture，验证内容不能执行或取得 Tauri IPC。
- 备份测试验证大文件流式处理、manifest 版本、指纹校验、空间不足、损坏包和失败后原书库保持可用。
- 性能验收关注可观察预算：最多两个活跃渲染器；大文件导入不整体读入 JS 内存；非活动标签不保留 PDF Canvas；书库封面按需加载。
- Reader Runtime 缓存验收运行 `pnpm --dir apps/reader test:reader-runtime-cache`：真实 Chrome 通过 `library.openBook`/`reader.activateView` Command 测量 EPUB 与 Markdown A→B→A，记录切换、首次可见、回切可交互、缓存命中、对象创建、范围读取、Runtime 资源和可获得的堆内存；至少三轮，以同机冷路径中位数/P95 作为动态门槛。
- 参考 Readest 的既有测试类型：Vitest jsdom、Vitest Browser、Playwright Web、WebdriverIO Tauri 与 Rust tests，但只引入当前切片真正需要的工具。

## Out of Scope

- AI 问答、Agent、Agent 模板、趣味技能、知识包、章节摘要、AI 目录和 AI 笔记生成。
- 账户、支付、遥测、云端存储、WebDAV、Google Drive、S3、OneDrive、Readest Cloud、端到端加密与多端同步。
- OCR、语义检索、向量数据库、全书库正文索引和跨书搜索。
- TTS、RSVP、翻译、词典、Word Lens、校对、阅读统计和第三方阅读服务同步。
- OPDS、RSS、在线书库、网页剪藏、邮件接收和远程下载。
- 手机、Linux、完整浏览器产品、PWA 和服务器渲染。
- 多原生窗口、递归分栏、超过两个 Editor Group 和复杂拖拽布局。
- EPUB 脚本、互动电子书运行时、远程书籍资源和任意自定义插件。
- Monaco、LSP、代码补全、Markdown 插件市场和富文本编辑器。
- 自动清空回收站、备份合并、备份加密和版本历史浏览。
- 从 Readest 导入现有账户、书库、设置、批注或位置。
- MOBI、AZW3、FB2、CBZ、TXT、DOCX、RTF 和 HTML 等额外格式。
- 正式的上游持续同步流程；仅按本产品需要选择性吸收安全和阅读内核修复。

## Further Notes

- 第一条实施路径必须保持极窄：Windows 启动、导入一份 EPUB、书库显示、标签打开、翻页、保存位置、重启恢复。该路径通过前不并行铺设全部功能。
- “大量借鉴 Readest”表示先查明其真实实现、理解修复背景、再选择性复用；不表示复制其状态模型、通用 SQL bridge、JSON 持久化或外围依赖。
- `foliate-js` 是重要的稳定资产，也是一条明确 Seam。项目应保留其来源、许可、固定提交和本地 Patch 记录。
- 旧设计中“从 Readest main 裁剪”和“保留抽样 MD5/metaHash”已被当前规格明确覆盖，不得在实现时重新引入。
- 旧设计中的 AI 伴读领域词汇、三层知识、模板化书籍 Agent、可替换 Runtime 与端到端加密同步原则已保留在产品愿景中，但不得提前创建空 package 或引入 SDK。
- 重要架构决定使用 ADR 记录；规格描述用户与系统承诺，ADR 描述为何选择当前 Seam。实现细节变化时更新 ADR 或新增替代 ADR，不静默改写历史。
- 规格状态为 `ready-for-agent`，但实施仍应按纵向切片拆票；单个事项必须能在一个代理会话内完成并包含独立验证。
