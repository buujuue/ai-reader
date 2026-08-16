-- 受管理导入的去重身份由「完整内容指纹」与「材料格式」共同组成。
-- pending 记录允许同一身份并存,以支持多个导入操作并发暂存；ready 记录必须唯一。
ALTER TABLE materials
    ADD COLUMN format TEXT NOT NULL DEFAULT 'unknown'
    CHECK (format IN ('epub', 'pdf', 'markdown', 'unknown'));

UPDATE materials
SET format = CASE
    WHEN lower(source_file_name) LIKE '%.epub' THEN 'epub'
    WHEN lower(source_file_name) LIKE '%.pdf' THEN 'pdf'
    WHEN lower(source_file_name) LIKE '%.md'
      OR lower(source_file_name) LIKE '%.markdown'
      OR lower(source_file_name) LIKE '%.mkd'
      OR lower(source_file_name) LIKE '%.mdown' THEN 'markdown'
    ELSE 'unknown'
END;

CREATE INDEX idx_materials_fingerprint_format
    ON materials(fingerprint, format);

CREATE UNIQUE INDEX idx_materials_ready_fingerprint_format
    ON materials(fingerprint, format)
    WHERE status = 'ready';
