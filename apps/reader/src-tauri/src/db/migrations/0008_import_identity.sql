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

-- 旧版本由代码查重而非数据库唯一约束保护。若历史数据库中已有重复 ready,
-- 保留最早创建的一条,其余记录及关联覆盖/批注按外键级联清理,避免建索引失败。
DELETE FROM materials
WHERE status = 'ready'
  AND EXISTS (
      SELECT 1
      FROM materials AS earlier
      WHERE earlier.status = 'ready'
        AND earlier.fingerprint = materials.fingerprint
        AND earlier.format = materials.format
        AND (
            earlier.created_at < materials.created_at
            OR (
                earlier.created_at = materials.created_at
                AND earlier.id < materials.id
            )
        )
  );

CREATE INDEX idx_materials_fingerprint_format
    ON materials(fingerprint, format);

CREATE UNIQUE INDEX idx_materials_ready_fingerprint_format
    ON materials(fingerprint, format)
    WHERE status = 'ready';
