-- 阅读材料最多归属于一个书库文件夹;NULL 表示树底部的未归类区域。
ALTER TABLE materials
    ADD COLUMN folder_id TEXT REFERENCES library_folders(id) ON DELETE SET NULL;

CREATE INDEX idx_materials_folder_id
    ON materials(folder_id);
