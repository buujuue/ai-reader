-- 书库文件夹拥有独立稳定身份和显式父级,不从名称路径推导身份。
CREATE TABLE library_folders (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    parent_id TEXT REFERENCES library_folders(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- SQLite NOCASE 只覆盖 ASCII; name_key 由 Rust 的 Unicode lowercase 生成。
-- COALESCE 让多个顶层文件夹(null parent_id)也参与同一唯一性约束。
CREATE UNIQUE INDEX idx_library_folders_parent_name
    ON library_folders(COALESCE(parent_id, ''), name_key);

CREATE INDEX idx_library_folders_parent
    ON library_folders(parent_id);
