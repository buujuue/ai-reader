-- 迁移:引入 pending/ready 导入状态机。
-- stage 时写入 pending 记录;commit 时先写元数据、再移动托管文件、最后置为 ready;
-- 启动恢复器据此完成(pending + 已存在托管文件)或回滚(pending 无托管文件)中断导入。
-- 同时移除指纹 UNIQUE 约束:查重只针对 ready 状态并由代码完成,允许多个 pending 共享指纹。

CREATE TABLE materials_new (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','ready')),
    fingerprint TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    language TEXT,
    source_file_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO materials_new (id, status, fingerprint, title, author, language, source_file_name, created_at, updated_at)
    SELECT id, status, fingerprint, title, author, language, source_file_name, created_at, updated_at
    FROM materials;

DROP TABLE materials;

ALTER TABLE materials_new RENAME TO materials;

CREATE INDEX idx_materials_fingerprint ON materials(fingerprint);