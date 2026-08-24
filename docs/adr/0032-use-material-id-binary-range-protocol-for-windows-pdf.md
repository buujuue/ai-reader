# ADR-0032：Windows PDF 使用 MaterialId 二进制范围协议

## 状态

已接受（工单 #44）。

## 背景

大型托管 PDF 通过现有 typed Tauri 范围命令读取时，每个 128 KiB 分块都要经过一次通用 `invoke`，Rust 还要把二进制编码为 Base64 后再由 WebView 解码。该路径保持了安全边界，但会把 PDF.js 的随机范围读取变成高频 IPC，并产生 Base64 临时内存。

Readest 的 `RemoteFile`/`rangefile` 模式证明了由 WebView 网络栈承载本地范围响应可以减少这类桥接开销。不过 Readest 的实现把绝对路径放入前端 URL；AI Reader 不接受这种授权模型，前端仍只能持有稳定 `MaterialId`。

## 决策

- Tauri 注册 `managed-range` custom URI scheme，对应 `http://managed-range.localhost/`。查询只接受 `materialId`、`offset` 和 `length`，范围语义是半开区间 `[offset, offset + length)`。
- Rust 协议处理器通过 `DatabaseHandle` 调用现有 `ImportRepository::read_managed_range`。因此每次请求都会验证材料为活跃 `ready` 状态、托管副本存在、范围不越界且单次不超过 8 MiB；路径只在 Rust 私有边界内解析。
- 响应直接使用二进制 `Vec<u8>`，通过 WebView `fetch` 交给 `ManagedFileSource`。错误返回无正文 HTTP 状态，不把内部路径或数据库信息泄漏给阅读内容。
- CORS 响应只允许 Tauri 应用 Origin 和本地开发 Origin；不反射任意网页的 `Origin`，无来源请求不获得跨源读取授权。
- 只有 Windows Tauri WebView 中的 PDF Source 选择该协议；浏览器内存 Repository、非 Windows Tauri、EPUB 和 Markdown 继续使用现有 Base64 typed range fallback。`ManagedFileSource` 的 File/Blob 兼容接口、128 KiB 分块、128 块 LRU、并发去重以及 PDF.js 最多 6 个在途范围不变。
- CSP 只允许 `connect-src http://managed-range.localhost`；Capability 不新增任意文件系统、Shell 或路径读取权限。协议注册在 Rust 应用壳内完成，前端不能动态扩大授权范围。

## 理由与边界

该协议减少 Windows 大型 PDF 的 Base64 和逐块通用 IPC 成本，同时保留现有 `MaterialId → active ready → managed path` 校验链。协议在非 Windows 目标上保持编译注册，但前端不选择它，当前目标平台仍以既有安全回退为准，不在本 ADR 中宣称同等原生性能。

PDF.js 的范围队列仍由 `pdfRangeTransport.ts` 负责，协议不会绕过取消、失败抑制、越界和最多 6 个并发请求的生命周期规则。EPUB/Markdown 不共享 Windows PDF 的传输选择，避免把性能优化误扩展成格式层授权变化。

## 验证

- TypeScript：`managedRangeProtocol.test.ts` 验证平台选择、URL 字段、HTTP 错误和响应长度校验；Tauri Adapter 测试验证 PDF 不调用通用范围 Command。
- Rust：`managed_range.rs` 与真实 SQLite 导入 Repository 测试验证查询字段、材料状态、半开范围、8 MiB 限制和错误状态映射。
- Windows 性能验收使用 `apps/reader/src/test/fixtures/pdf/pdfFixtures.ts` 生成 640 页、超过 80 MiB 的结构型 PDF，记录首屏/翻页范围字节、峰值内存和请求路径；浏览器降级脚本只证明 Source 语义，不替代 Tauri 网络栈证据。

## 参考来源

- Readest `apps/readest-app/src/utils/file.ts` 的 `RemoteFile`：用 WebView `fetch` 读取本地范围并保持惰性缓存。
- Readest `apps/readest-app/src-tauri/src/range_file.rs`：用自定义 URI scheme 返回二进制范围响应。

AI Reader 仅借鉴网络传输模式，重新实现 `MaterialId` 授权和 Rust 私有路径校验，不移植 Readest 的绝对路径 URL 或 asset scope 授权模型。来源与许可证见 `docs/legal/third-party.md`。
