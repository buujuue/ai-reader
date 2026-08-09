-- 迁移:引入材料文档版本(document_version)。
-- 正式保存 Markdown 时递增文档版本、更新完整内容指纹并重建 BookDocument(ADR-0009)。
-- 文档版本用于锚点恢复与版本冲突判断;EPUB/PDF 内容不可变,默认保持 0。
ALTER TABLE materials ADD COLUMN document_version INTEGER NOT NULL DEFAULT 0;