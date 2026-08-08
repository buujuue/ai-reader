-- 迁移:引入批注(高亮与文字笔记)。
-- 批注是阅读材料级领域实体,归属于稳定 BookId(material_id),不归属某个阅读视图。
-- 文本锚点(Text Anchor)保存 CFI、引文、前后文、文档版本与恢复状态(ADR-0008),
-- 绝不只保存 DOM Range;恢复失败时 recovery_state 标记为 orphaned 保留为失联批注。
CREATE TABLE annotations (
    id TEXT PRIMARY KEY NOT NULL,
    material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    cfi TEXT NOT NULL,
    quote TEXT NOT NULL,
    before TEXT NOT NULL DEFAULT '',
    after TEXT NOT NULL DEFAULT '',
    document_version TEXT NOT NULL DEFAULT '',
    recovery_state TEXT NOT NULL DEFAULT 'resolved' CHECK (recovery_state IN ('resolved', 'orphaned')),
    style TEXT NOT NULL DEFAULT 'highlight',
    color TEXT NOT NULL DEFAULT '#ffd54f',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE INDEX idx_annotations_material ON annotations(material_id, deleted_at);