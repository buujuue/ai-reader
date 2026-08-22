---
status: accepted
---

# ADR-0028：以稳定材料标识提供托管文件范围来源

## 背景

现有导入 Repository 的 `readManagedFile` 会把托管材料全部读入前端，适合当前已经落地的打开路径，但不适合大型 EPUB、PDF 或未来需要按需读取的格式层。把托管路径传给 WebView 或让格式层直接调用 Tauri 文件 API，会绕过稳定 `BookId`、材料生命周期和 Rust 私有文件边界。

## 决策

- `ImportRepository` 增加 `openManagedFileSource(materialId)`，返回只读 `ManagedFileSource`。原有全量 `readManagedFile` 保留，EPUB、PDF、Markdown 的当前打开路径不在本决策中改写。
- `ManagedFileSource` 继承 `File`，同步暴露 `name`、`size`、`type` 等元数据，`slice()`、`arrayBuffer()`、`text()` 和 `stream()` 延迟通过半开区间读取内容。格式层只依赖 File/Blob 兼容面，不依赖 Tauri 命令、SQLite 或文件系统路径。
- Tauri 端先按稳定 `materialId` 获取托管文件名称和长度，再通过 `read_managed_file_range(materialId, offset, length)` 读取范围。范围语义为 `[offset, offset + length)`，单次最多 8 MiB；Rust 只接受活跃 `ready` 材料，越界、超限、未知材料和缺失托管副本都返回可诊断错误。
- TypeScript 端按 128 KiB 分块缓存，最多保留 128 块，LRU 淘汰最久未使用分块；同一分块的并发读取共享 Promise。内存 Repository 使用相同 Source 契约，浏览器降级和测试不依赖 Tauri。

## 理由与边界

Rust 是托管文件路径、材料状态和范围安全的唯一拥有者；TypeScript 只编排惰性读取与格式兼容。范围命令采用 base64 作为现有 typed Tauri 字节传输的兼容载荷，但不把路径或任意文件系统能力暴露给前端。8 MiB 上限保证一次 IPC 请求不会退化成不受控的全量读取；128 KiB/128 块缓存与 Readest 已验证的按需访问模式一致，同时控制 WebView 内存占用。

## 参考实现与取舍

分块缓存、LRU 访问顺序和同范围并发去重参考 Readest `apps/readest-app/src/utils/file.ts` 中的 `NativeFile`/`RemoteFile`。AI Reader 仅采用其底层访问模式，重新实现为稳定材料标识 + typed Repository + Rust 私有托管目录，不复制 Readest 的路径授权、应用层状态或阅读器打开流程。来源与许可证登记见 `docs/legal/third-party.md`。
