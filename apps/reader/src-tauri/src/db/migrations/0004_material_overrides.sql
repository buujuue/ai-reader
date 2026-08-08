-- 迁移:引入资料元数据覆盖。
-- 来源元数据作为不可编辑快照保存在 materials 表(title/author/language);
-- 用户覆盖值作为独立数据保存在 material_overrides 表,整理操作永不改写阅读文件。
-- 有效元数据 = 覆盖优先、来源兜底:COALESCE(override.title, materials.title) 等。
-- 自定义封面进入应用托管空间,cover_source 记录托管封面文件名;删除或替换不影响外部原文件。
CREATE TABLE material_overrides (
    material_id TEXT PRIMARY KEY NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    title TEXT,
    author TEXT,
    cover_source TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);