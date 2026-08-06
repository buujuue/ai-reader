# `src/domain/reader` — 阅读文档子域

## 功能

- `bookDocument.ts`：`BookDocument` 统一文档接口（元数据、打开、位置读写、下一页/上一页、位置订阅、关闭）。EPUB、PDF、Markdown 都实现该接口；Reader 外部不直接依赖 Foliate View。
- `readingLocation.ts`：可序列化的 `ReadingLocation`（第一版为 EPUB CFI）与形状校验。
- `sanitizer.ts`：`sanitizeEpubContent` 内容清洗器。永久移除脚本、iframe、object、embed、表单、事件处理器属性与危险 URL，落实 ADR-0010。清洗是打开 EPUB 的必经步骤，无"信任此书"开关。
- `epubBookDocument.ts`：`EpubBookDocument` 实现。把不可信内容清洗、Foliate 渲染器挂载、位置读取/恢复与导航封装在窄接口后；`wireSecurity` 在内容进入渲染器前清洗 XHTML，并把 relocate 事件转成 `ReadingLocation`。
- `viewHost.ts` / `foliateViewHost.ts`：`FoliateViewHost` 窄接口与 `FoliateViewHostFactory` 工厂。生产实现懒加载 `foliate-js` 的 `view.js` 并创建 `foliate-view` 元素；测试注入伪宿主。所有对具体渲染器的直接调用都集中在本层。
- 对应 `*.test.ts`：清洗器与 `EpubBookDocument` 行为测试（用伪宿主，不依赖真实浏览器渲染）。

## 依赖其它文件夹（树）

无（`domain/reader` 不依赖其它 `src/` 文件夹；运行时经 `foliate-js` 依赖渲染）。

## 被谁依赖（树）

```
domain/reader/
├── domain/workspace/     ReadingLocation 进入 WorkspaceState 的阅读视图位置
└── workbench/
    ├── readerCommands.ts 创建 EpubBookDocument 并执行打开/翻页/关闭
    └── readerRuntime.ts  持有活 BookDocument 对象
```

## 依赖方向

`domain/reader` 是阅读语义的深模块：把具体渲染器与清洗逻辑隔离在内部，通过 `BookDocument` 与 `ReadingLocation` 向上层提供窄接口。外部模块不得直接操作 Foliate View。