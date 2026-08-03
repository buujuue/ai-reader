---
status: accepted
---

# 在 BookDocument 后统一 EPUB、PDF 与 Markdown

EPUB、PDF、Markdown 统一实现 `BookDocument`，向 Reader 提供元数据、目录、章节或页面、封面、搜索、位置解析和导航能力。Reader 外部不得直接依赖 Foliate View。

项目保留 Readest 的 `foliate-js` 分支作为初始唯一固定来源依赖，并继续使用 PDF.js。Markdown 经过解析、清洗和一级标题分段后构造内存 BookDocument；保存后重新构建。

只有每个可见 Editor Group 的活动 ReadingView 挂载渲染器，因此最多两个活跃 Foliate View。非活动标签保留可序列化状态并释放 DOM、Canvas 和异步资源。
