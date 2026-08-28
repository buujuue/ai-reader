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
    #[error("Markdown 恢复快照无法写入:{0}")]
    MarkdownRecoverySerialize(serde_json::Error),
    #[error("应用数据目录初始化失败:{0}")]
    AppDir(String),
    #[error("数据库连接被占用且无法恢复")]
    DatabaseLocked,
    #[error("文件系统操作失败:{0}")]
    Io(#[from] std::io::Error),
    #[error("没有权限读取文件:{0}")]
    Permission(String),
    #[error("磁盘空间不足:{0}")]
    DiskFull(String),
    #[error("暂存文件不存在:{0}")]
    StagedFileMissing(String),
    #[error("托管书库中不存在该阅读材料:{0}")]
    ManagedFileMissing(String),
    #[error("托管材料单次范围读取超过 8 MiB 上限:{0} bytes")]
    ManagedRangeTooLarge(u64),
    #[error("托管材料范围越界:offset={offset},length={length},size={size}")]
    ManagedRangeOutOfBounds { offset: u64, length: u64, size: u64 },
    #[error("阅读材料不存在:{0}")]
    MaterialNotFound(String),
    #[error("阅读材料内容与已有材料重复:{0}")]
    DuplicateMaterial(String),
    #[error("阅读材料标识不合法:{0}")]
    InvalidMaterialId(String),
    #[error("文件夹名称不合法:{0}")]
    InvalidLibraryFolderName(String),
    #[error("文件夹不存在:{0}")]
    LibraryFolderNotFound(String),
    #[error("父文件夹不存在:{0}")]
    LibraryFolderParentNotFound(String),
    #[error("同一父级下已有同名文件夹,请换一个名称:{0}")]
    LibraryFolderNameConflict(String),
    #[error("文件夹已达到最多五层")]
    LibraryFolderDepthExceeded,
    #[error("文件夹层级数据存在循环")]
    LibraryFolderCycle,
    #[error("备份 manifest 无法写入:{0}")]
    BackupManifestSerialize(serde_json::Error),
    #[error("备份目标已存在:{0}")]
    BackupDestinationExists(String),
    #[error("备份源文件在导出期间发生变化:{0}")]
    BackupSourceChanged(String),
    #[error("备份归档无法写入:{0}")]
    BackupArchive(String),
    #[error("备份文件无法恢复:{0}")]
    BackupRestore(String),
    #[error("备份文件格式或内容校验失败:{0}")]
    BackupValidation(String),
    #[error("备份恢复状态无法读取:{0}")]
    BackupRecoveryState(String),
    #[error("EPUB 原生预取失败:{0}")]
    EpubPrefetch(String),
    #[error("EPUB 推导目录缓存参数不合法:{0}")]
    InvalidDerivedTocCache(String),
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// 把 io 错误映射为带行动语义的领域错误,便于前端按类别展示可操作的简体中文文案。
pub fn classify_io_error(source: std::io::Error) -> AppError {
    use std::io::ErrorKind;
    match source.kind() {
        ErrorKind::PermissionDenied => AppError::Permission(source.to_string()),
        ErrorKind::StorageFull | ErrorKind::WriteZero => AppError::DiskFull(source.to_string()),
        _ => AppError::Io(source),
    }
}
