---
status: accepted
---

# 使用 Rust 独占的 SQLite 持久化

SQLite 保存阅读材料、来源元数据与覆盖、批注、阅读位置、工作区和设置。Rust 独占连接、迁移、SQL、事务和外键规则；TS 通过领域化 Repository Interface 访问。

低查询频率的格式设置可以作为版本化 JSON 字段保存；高价值实体保持独立行。封面、材料文件、恢复快照和可再生成缓存保存在文件系统。

阅读位置使用节流写入并在关闭时 flush。批注、回收站、导入提交和正式文档保存使用事务或明确的可恢复状态机。

TS 提供内存 Repository Adapter，并与 Tauri Adapter 共享领域契约测试。Readest 的通用 SQL bridge 和以 JSON 文件为核心书库的方式不被继承。
