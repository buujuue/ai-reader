---
status: accepted
---

# 以材料唯一归属连接书库文件夹

每份活跃 Reading Material 在 `materials.folder_id` 中保存一个可为空的
`FolderId`。`NULL` 表示树底部的未归类区域；非空值必须引用一个已有书库文件夹。
材料只能有一个归属，移动材料只更新这一列，不复制或改写托管正文、封面、阅读位置和批注。

## 决策

- `ReadingMaterial` 对外暴露 `folderId: string | null`，导入新材料时固定为 `null`。
- `ImportRepository` 提供 `moveMaterialToFolder(materialId, folderId)`；`folderId = null`
  用于移回未归类。Command 层再次根据权威文件夹列表校验目标，Tauri/Rust 侧用 SQLite
  外键和活动材料校验兜底。
- 文件夹树仍由 `LibraryFolderRepository` 管理；书库侧栏把材料渲染为对应文件夹的叶子节点，
  未归类材料固定在树底部。单本移动入口使用材料操作菜单，不引入多选或批量移动。
- 普通移入回收站、恢复、Markdown 正式保存和 EPUB 版本迁移只更新各自已有字段，必须保留
  `folder_id`。永久删除随材料记录级联清理归属。
- 完整备份直接保存 SQLite 一致快照，因此材料归属和文件夹结构与既有备份协议一同恢复。

## 理由

归属是阅读材料的组织元数据，不属于文件夹树的展示状态，也不应混入 Workspace State。
把它放在材料记录中可以保证稳定 MaterialId 下的唯一归属，并让移动、回收站恢复和备份恢复
共享同一个持久化事实；可空外键则让旧数据库和无文件夹材料安全落入未归类。

## 取舍

单本菜单移动覆盖首版需求，但暂不提供拖拽、多选和批量移动。文件夹删除继续沿用
ADR-0035 的“转为未归类”语义，由 `LibraryFolderRepository.deleteFolder` 在同一 SQLite
事务中显式清除活跃与回收站材料归属，再按后序删除文件夹子树；`ON DELETE SET NULL`
作为数据库层兜底，保证归属不会悬空。

## 相关 ADR

- 0007：稳定资料身份、完整指纹与托管导入。
- 0015：应用内回收站与显式永久清理。
- 0034：以文件夹树作为默认书库视图。
- 0035：删除文件夹时保留材料并转为未归类。
- 0037：完整备份包含书库文件夹结构。
