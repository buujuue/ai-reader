/// 应用级错误。Tauri 命令返回错误要求可序列化,
/// 这里统一序列化为人类可读的中文字符串,前端按文案展示。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误:{0}")]
    Database(#[from] rusqlite::Error),
    #[error("工作区状态数据无法解析:{0}")]
    WorkspaceStateParse(#[from] serde_json::Error),
    #[error("工作区状态数据无法写入:{0}")]
    WorkspaceStateSerialize(serde_json::Error),
    #[error("应用数据目录初始化失败:{0}")]
    AppDir(String),
    #[error("数据库连接被占用且无法恢复")]
    DatabaseLocked,
    #[error("文件系统操作失败:{0}")]
    Io(#[from] std::io::Error),
    #[error("暂存文件不存在:{0}")]
    StagedFileMissing(String),
    #[error("导入提交失败:{0}")]
    ImportCommit(String),
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
