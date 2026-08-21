---
status: accepted
---

# 原生导航缺失时推导 EPUB 临时目录

当 EPUB 的 OPF/spine 与正文仍可读、但 NAV/NCX 没有可导航目标时，阅读器继续打开正文，并由 TypeScript 在受预算约束的章节标题扫描中生成临时目录。扫描只读取 h1-h6，忽略 nav、aside、footer、hidden 和 aria-hidden 标题；优先使用标题的 id/name 作为 fragment，没有稳定锚点时退回章节 href。

推导目录是非权威的运行时结果：不修改原始 EPUB、不改写 foliate 的原生目录、不写入用户工作区或同步数据。没有可靠标题时目录为空，但正文的前后翻页与位置进度仍然可用。推导过程不使用 AI、索引或网络。

推导最多扫描 128 个 spine 章节、每章 512 KiB、整本 4 MiB，并限制目录节点数、层级和标签长度；实际章节尺寸超过单章预算时在读取前跳过。单章读取或解析失败只影响该章目录。

目录缓存按完整材料指纹(`bookHash`)与算法版本组成的键隔离。Tauri 通过 typed 命令将小型带版本目录 JSON 原子写入应用私有派生缓存目录；该目录不进入书库备份或同步边界。缓存损坏、版本不匹配或指纹变化时丢弃并重建。浏览器降级环境只使用内存缓存。

该决策借鉴 Readest 的 EPUB 导航回退思路，但保留 AI Reader 的 `BookDocument`、Repository 与 Rust 文件边界；不移植 Readest 应用层导航状态。
