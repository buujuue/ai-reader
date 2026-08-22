# ADR-0031：EPUB 通过 ManagedFileSource 惰性读取

## 状态

已接受（工单 #36）。

## 背景

EPUB 之前在打开前通过 `readManagedFile` 把托管副本完整传入前端，再由 ZIP 读取器和 `EpubBookDocument` 分别复制为 `Uint8Array` 与 `File`。大型 EPUB 因此会在检查、创建阅读器和资源加载阶段产生整书传输与重复内存占用。

## 决策

- `inspectEpub`、`EpubBookDocument` 与 `foliateEpubLoader` 统一接收只读的 `File/Blob` 兼容来源；托管材料打开时由 `ImportRepository.openManagedFileSource(materialId)` 创建一次并贯穿检查与阅读。
- ZIP 打开阶段只通过惰性 `slice()` 读取文件尾部、中央目录、`META-INF/container.xml`、OPF、导航和首个可阅读章节。其它章节、图片、字体、样式和媒体只在 Foliate 实际请求时读取。
- ZIP 条目读取校验本地文件头与中央目录，按条目读取压缩数据；同一条目的并发请求共享进行中的 Promise，Promise settle 后释放，不保留整条目正文缓存。底层 `ManagedFileSource` 继续负责 128 KiB 分块 LRU 与分块级并发去重。
- 导入暂存阶段已有的 `Uint8Array` 仍可在检查入口包装为内存 `Blob`；该兼容路径只覆盖暂存协议，托管材料的打开路径不得回退到 `readManagedFile`。
- Foliate 元数据语义仍是唯一来源；预检获取封面存在性使用 OPF manifest 的结构标记，不为判断封面而读取封面二进制。

## 后果

- 大型 EPUB 打开不再需要 Base64 全量传输或整书 `Uint8Array` 复制，范围读取缓存可在检查与阅读之间复用。
- 首次打开只会物化 ZIP 索引、入口 XML、导航和当前首章；正文切换与资源加载的内存生命周期由 Foliate 请求和条目读取 Promise 控制。
- ZIP 中央目录仍需一次性读取，这是 ZIP 随机访问所需的索引，而不是正文全量读取。ZIP64 与多磁盘包继续按既有安全边界拒绝。

## 参考实现与取舍

Readest 的 `apps/readest-app/src/utils/file.ts` 与 Foliate 的 `view.js` 使用 Blob `slice()`、范围缓存和 ZIP reader 实现按需访问。AI Reader 只沿用该行为模式，重新实现为稳定 `MaterialId`、typed Repository 和自有预算 ZIP 解析器，不直接复制 Readest 代码；相关借鉴与许可记录见 `docs/legal/third-party.md`。
