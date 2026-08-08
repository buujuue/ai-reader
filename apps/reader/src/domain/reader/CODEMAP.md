# `src/domain/reader` — 阅读文档子域

## 功能

- `bookDocument.ts`：`BookDocument` 统一文档接口（元数据、打开、位置读写、目录、书内链接跳转、书内/外部链接事件、下一页/上一页、搜索、位置订阅、关闭）。EPUB、PDF、Markdown 都实现该接口；Reader 外部不直接依赖 Foliate View。
- `toc.ts`：`TocItem`/`Toc` 类型，与 foliate-js `book.toc` 结构一致的分层目录。
- `navigationHistory.ts`：每个 ReadingView 的可序列化导航历史（最多 50 个节点）。显式跳转 `pushExplicit` 新增节点、普通翻页 `replaceCurrent` 替换当前节点、`back`/`forward` 后退前进；纯数据结构，可随工作区持久化。
- `readingLocation.ts`：可序列化的 `ReadingLocation`（第一版为 EPUB CFI）与形状校验。
- `typography.ts`：阅读排版设置（字体、字号、行距、页边距、主题、分页/滚动）。定义完整设置 `ReadingTypography`、全局默认 `DEFAULT_READING_TYPOGRAPHY`、材料级覆盖与全局默认的合并规则 `resolveTypography`，以及把排版注入文档的 `buildTypographyCss`。字体与颜色全部来自固定映射，不拼接不可信字符串，落实 ADR-0010 不放开安全边界。
- `sanitizer.ts`：`sanitizeEpubContent` 内容清洗器。永久移除脚本、iframe、object、embed、表单、事件处理器属性与危险 URL，落实 ADR-0010。清洗是打开 EPUB 的必经步骤，无"信任此书"开关。
- `epubBookDocument.ts`：`EpubBookDocument` 实现。把不可信内容清洗、Foliate 渲染器挂载、位置读取/恢复、目录读取、href 导航与书内/外部链接事件封装在窄接口后；`wireSecurity` 在内容进入渲染器前清洗 XHTML，把 relocate 事件转成 `ReadingLocation`，并把书内/外部链接事件面向上层。
- `viewHost.ts` / `foliateViewHost.ts`：`FoliateViewHost` 窄接口与 `FoliateViewHostFactory` 工厂。生产实现懒加载 `foliate-js` 的 `view.js` 并创建 `foliate-view` 元素；测试注入伪宿主。提供 `getTOC`/`goToHref`/`onInternalLink`/`onExternalLink`，以 preventDefault 阻止书内与外部链接的默认导航，把 href/URL 面向上层统一处理；`search`/`clearSearch` 把 foliate 的原始搜索产出归一化为领域事件并委托高亮；`applyTypography` 把排版经分页器 attribute（flow/gap/margin/max-inline-size/max-block-size/max-column-count）与 `setStyles` 注入文档。所有对具体渲染器的直接调用都集中在本层。
- 对应 `*.test.ts`：清洗器、`EpubBookDocument`、搜索归一化与排版合并/建 CSS 行为测试（用伪宿主，不依赖真实浏览器渲染）。
- `search.ts`：当前材料搜索的领域类型（`SearchExcerpt`、`SearchMatch`、`SearchEvent`、`SearchOptions`）。搜索只针对当前激活 ReadingView，不跨书建索引。
- 对应 `*.test.ts`：清洗器、`EpubBookDocument` 与搜索归一化行为测试（用伪宿主，不依赖真实浏览器渲染）。

## 依赖其它文件夹（树）

无（`domain/reader` 不依赖其它 `src/` 文件夹；运行时经 `foliate-js` 依赖渲染）。

## 被谁依赖（树）

```
domain/reader/
├── domain/workspace/     ReadingLocation 与 NavigationHistory 进入 WorkspaceState 的阅读视图
└── workbench/
    ├── readerCommands.ts 创建 EpubBookDocument 并执行打开/翻页/跳转/关闭与历史接线
    ├── readerRuntime.ts  持有活 BookDocument 对象
    └── workspaceStore.ts 用 navigationHistory 管理视图历史
```

## 依赖方向

`domain/reader` 是阅读语义的深模块：把具体渲染器与清洗逻辑隔离在内部，通过 `BookDocument`、`ReadingLocation` 与 `NavigationHistory` 向上层提供窄接口。外部模块不得直接操作 Foliate View。