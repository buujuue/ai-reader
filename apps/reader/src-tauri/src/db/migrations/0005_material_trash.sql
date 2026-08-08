-- 迁移:引入书库回收站。
-- 普通删除只给材料打上 deleted_at 时间戳,保留 BookId、托管文件、封面、覆盖与批注/位置/设置;
-- 活跃书库只显示 deleted_at IS NULL 的材料;回收站显示 deleted_at IS NOT NULL 的材料。
-- 恢复即清空 deleted_at;永久删除才级联清理托管文件与记录。
-- 第一版不提供定时或自动清空回收站。
ALTER TABLE materials ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_materials_deleted_at ON materials(deleted_at);