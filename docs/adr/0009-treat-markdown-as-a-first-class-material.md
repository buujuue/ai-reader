---
status: accepted
---

# 将 Markdown 作为可阅读、可编辑的一等材料

Markdown 阅读模式复用统一 BookDocument 与 Foliate View；源码模式按需加载 CodeMirror 6。Monaco 因体积和移动端支持边界不采用，原生 textarea 也不足以承担完整文档编辑。

同一材料只有一个按 MaterialId 标识的 `MarkdownDocumentSession`，唯一 ReadingView 使用该未保存缓冲区。视图仍独立拥有阅读位置和阅读/源码模式。

正式内容只在用户保存时由 Rust 原子替换，并递增文档版本、更新完整指纹、重建 BookDocument 和恢复批注锚点。编辑期间自动写恢复快照但不改变正式版本；启动时允许恢复或丢弃，基础版本变化时按冲突处理。
