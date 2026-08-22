---
status: accepted
---

# ADR-0029：Markdown 通过托管文件范围来源读取

## 背景

工单 #33 已提供按稳定 `MaterialId` 获取的 `ManagedFileSource`，但 Markdown 打开、放弃编辑和保存后重建仍直接调用生产 Tauri 的 `readManagedFile` 全量 Base64 接口。这样会让 Markdown 绕过统一文件来源边界，也无法在不放宽单次范围上限的情况下读取大文档。

## 决策

- Markdown 的打开、编辑放弃、脏关闭放弃、保存后阅读视图重建和重新打开，统一通过 `ImportRepository.openManagedFileSource(materialId)` 获取来源。
- 完整 UTF-8 文本只在 `domain/reader/markdown/markdownSource.ts` 内物化；该模块只依赖 Blob 兼容来源的 `stream()`，按 128 KiB 分块顺序读取，因此单次范围请求不会超过 Source/Rust 的协议上限。
- EPUB 与 PDF 继续保留各自需要完整字节缓冲的打开路径，不把 Markdown 的文本物化 helper 或 Source 回退逻辑扩展到其它格式。
- 当前 Markdown 解析器仍要求完整字符串；增量 Markdown 解析不在工单 #34 范围内。

## 理由与边界

Source 的统一边界由书库 Repository 负责材料身份、托管副本可用性和范围安全；Markdown 领域负责把受控字节流转换成既有解析器所需的完整文本。浏览器内存 Adapter 与 Tauri Adapter 因此共享相同的打开、编辑、保存和重新打开语义，而不需要暴露文件路径或新增通用全量读取接口。
