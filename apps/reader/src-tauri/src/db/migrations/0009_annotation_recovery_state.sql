-- 迁移:允许批注显式记录“已重锚”状态。
-- SQLite 不能直接修改既有 CHECK 约束,因此重建同一张表并保留全部 tombstone。
PRAGMA foreign_keys = OFF;

ALTER TABLE annotations RENAME TO annotations_before_recovery_state;

CREATE TABLE annotations (
    id TEXT PRIMARY KEY NOT NULL,
    material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    cfi TEXT NOT NULL,
    quote TEXT NOT NULL,
    before TEXT NOT NULL DEFAULT '',
    after TEXT NOT NULL DEFAULT '',
    document_version TEXT NOT NULL DEFAULT '',
    recovery_state TEXT NOT NULL DEFAULT 'resolved'
        CHECK (recovery_state IN ('resolved', 'reanchored', 'orphaned')),
    style TEXT NOT NULL DEFAULT 'highlight',
    color TEXT NOT NULL DEFAULT '#ffd54f',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

INSERT INTO annotations (
    id, material_id, cfi, quote, before, after, document_version,
    recovery_state, style, color, note, created_at, updated_at, deleted_at
)
SELECT
    id, material_id, cfi, quote, before, after, document_version,
    recovery_state, style, color, note, created_at, updated_at, deleted_at
FROM annotations_before_recovery_state;

DROP TABLE annotations_before_recovery_state;
PRAGMA foreign_keys = ON;

CREATE INDEX idx_annotations_material ON annotations(material_id, deleted_at);
