use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{classify_io_error, AppError};

/// 应用托管文件布局。所有阅读材料与暂存文件都位于应用数据目录下的私有空间,
/// 外部原文件永不被修改或删除。
#[derive(Debug, Clone)]
pub struct LibraryPaths {
    pub app_data_dir: PathBuf,
    pub stash_dir: PathBuf,
    pub managed_dir: PathBuf,
    pub covers_dir: PathBuf,
    pub recovery_dir: PathBuf,
    /// 显式 EPUB 版本迁移的本地恢复快照,不进入备份归档或同步边界。
    pub version_migration_dir: PathBuf,
}

impl LibraryPaths {
    /// 在应用数据目录下创建暂存、托管书库与托管封面目录。
    pub fn new(app_data_dir: &Path) -> Result<Self, AppError> {
        let stash_dir = app_data_dir.join("stash");
        let managed_dir = app_data_dir.join("library");
        let covers_dir = app_data_dir.join("covers");
        let recovery_dir = app_data_dir.join("recovery");
        let version_migration_dir = app_data_dir.join("version-migrations");
        std::fs::create_dir_all(&stash_dir)?;
        std::fs::create_dir_all(&managed_dir)?;
        std::fs::create_dir_all(&covers_dir)?;
        std::fs::create_dir_all(&recovery_dir)?;
        std::fs::create_dir_all(&version_migration_dir)?;
        Ok(Self {
            app_data_dir: app_data_dir.to_path_buf(),
            stash_dir,
            managed_dir,
            covers_dir,
            recovery_dir,
            version_migration_dir,
        })
    }

    pub fn database_path(&self) -> PathBuf {
        self.app_data_dir.join("ai-reader.db")
    }

    pub fn stash_path(&self, id: &str) -> PathBuf {
        self.stash_dir.join(id)
    }

    pub fn managed_path(&self, id: &str) -> PathBuf {
        self.managed_dir.join(id)
    }

    pub fn cover_path(&self, id: &str) -> PathBuf {
        self.covers_dir.join(id)
    }

    pub fn recovery_path(&self, material_id: &str) -> Result<PathBuf, AppError> {
        let mut components = Path::new(material_id).components();
        let is_single_normal_component =
            matches!(components.next(), Some(std::path::Component::Normal(_)))
                && components.next().is_none();
        if material_id.is_empty() || !is_single_normal_component {
            return Err(AppError::InvalidMaterialId(material_id.to_string()));
        }
        Ok(self.recovery_dir.join(format!("{material_id}.json")))
    }

    pub fn version_migration_path(&self, snapshot_id: &str) -> Result<PathBuf, AppError> {
        let mut components = Path::new(snapshot_id).components();
        let is_single_normal_component =
            matches!(components.next(), Some(std::path::Component::Normal(_)))
                && components.next().is_none();
        if snapshot_id.is_empty() || !is_single_normal_component {
            return Err(AppError::InvalidMaterialId(snapshot_id.to_string()));
        }
        Ok(self.version_migration_dir.join(snapshot_id))
    }
}

/// 以流式方式把源文件全部字节复制到目标路径,同时计算完整内容指纹(SHA-256 十六进制)。
/// 固定 64 KiB 缓冲,不把大文件整体读入内存。
pub fn stream_copy_with_fingerprint(source: &Path, destination: &Path) -> Result<String, AppError> {
    let mut reader = File::open(source).map_err(classify_io_error)?;
    let mut writer = File::create(destination).map_err(classify_io_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let read = reader.read(&mut buffer).map_err(classify_io_error)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        writer
            .write_all(&buffer[..read])
            .map_err(classify_io_error)?;
    }
    writer.flush().map_err(classify_io_error)?;
    writer.sync_all().map_err(classify_io_error)?;

    Ok(hex(&hasher.finalize()))
}

/// 流式计算已有文件的完整内容指纹,不把文件整体载入内存。
/// 启动恢复用它核对「文件已移动、数据库尚未置 ready」这一中断窗口。
pub fn fingerprint_file(path: &Path) -> Result<String, AppError> {
    let mut reader = File::open(path).map_err(classify_io_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let read = reader.read(&mut buffer).map_err(classify_io_error)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 计算给定字节的完整内容指纹(SHA-256 十六进制)。用于保存后重新计算新版本的指纹。
pub fn fingerprint_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

/// 读取文件全部字节。仅用于把暂存文件交给 TypeScript 端检查格式与提取元数据,
/// 不用于大文件指纹计算(那部分始终走流式)。
pub fn read_file_bytes(path: &Path) -> Result<Vec<u8>, AppError> {
    std::fs::read(path).map_err(classify_io_error)
}

/// 原子写入:把字节写入同一目录下的临时文件,再原子替换目标路径。
/// 用于正式保存 Markdown(ADR-0009):先用临时文件写全内容,替换成功后
/// 目标文件要么是旧的完整版本、要么是新的完整版本,不会出现半本内容。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let temp_path = parent.join(format!(".{file_name}.tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&temp_path, bytes).map_err(classify_io_error)?;
    match std::fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(classify_io_error(error))
        }
    }
}

/// 从应用私有文件流式复制并原子替换目标,用于版本迁移提交和恢复快照切换。
/// 读取源文件只发生在 Rust 边界内;目标不会暴露给 TypeScript,也不把 EPUB 全部载入内存。
pub fn atomic_copy(path: &Path, target: &Path) -> Result<(), AppError> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let temp_path = parent.join(format!(".{file_name}.copy-tmp-{}", uuid::Uuid::new_v4()));
    if let Err(error) = stream_copy_with_fingerprint(path, &temp_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }
    match std::fs::rename(&temp_path, target) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(classify_io_error(error))
        }
    }
}

/// 把用户选择的导出内容先完整写入临时文件,再替换目标文件。
/// 目标已存在时先移到同目录备份,从而兼容 Windows 的 rename 语义并避免留下半份导出。
pub fn atomic_write_export_file(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export.md".to_string());
    let temp_path = parent.join(format!(".{file_name}.tmp-{}", uuid::Uuid::new_v4()));
    let backup_path = parent.join(format!(".{file_name}.bak-{}", uuid::Uuid::new_v4()));

    if let Err(error) = std::fs::write(&temp_path, bytes) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(classify_io_error(error));
    }

    let had_existing = path.exists();
    if had_existing {
        if let Err(error) = std::fs::rename(path, &backup_path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(classify_io_error(error));
        }
    }

    match std::fs::rename(&temp_path, path) {
        Ok(()) => {
            if had_existing {
                let _ = std::fs::remove_file(&backup_path);
            }
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(path);
            if had_existing {
                let _ = std::fs::rename(&backup_path, path);
            }
            let _ = std::fs::remove_file(&temp_path);
            Err(classify_io_error(error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-reader-fs-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn stream_copy_creates_identical_bytes_and_stable_fingerprint() {
        let dir = temp_dir();
        let source = dir.join("source.bin");
        std::fs::write(&source, b"hello world").unwrap();

        let first = stream_copy_with_fingerprint(&source, &dir.join("a.bin")).unwrap();
        let second = stream_copy_with_fingerprint(&source, &dir.join("b.bin")).unwrap();

        assert_eq!(first, second);
        assert_eq!(
            first,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        assert_eq!(std::fs::read(dir.join("a.bin")).unwrap(), b"hello world");
    }

    #[test]
    fn fingerprint_changes_with_content() {
        let dir = temp_dir();
        std::fs::write(dir.join("a.bin"), b"one").unwrap();
        std::fs::write(dir.join("b.bin"), b"two").unwrap();

        let a = stream_copy_with_fingerprint(&dir.join("a.bin"), &dir.join("a.out")).unwrap();
        let b = stream_copy_with_fingerprint(&dir.join("b.bin"), &dir.join("b.out")).unwrap();

        assert_ne!(a, b);
    }

    #[test]
    fn library_paths_creates_subdirectories() {
        let dir = temp_dir();
        let paths = LibraryPaths::new(&dir).unwrap();

        assert!(paths.stash_dir.is_dir());
        assert!(paths.managed_dir.is_dir());
        assert!(paths.covers_dir.is_dir());
        assert!(paths.recovery_dir.is_dir());
        assert!(paths.version_migration_dir.is_dir());
        assert_eq!(paths.stash_path("abc"), dir.join("stash").join("abc"));
        assert_eq!(paths.managed_path("abc"), dir.join("library").join("abc"));
        assert_eq!(paths.cover_path("abc"), dir.join("covers").join("abc"));
        assert_eq!(
            paths.recovery_path("abc").unwrap(),
            dir.join("recovery").join("abc.json")
        );
        assert_eq!(
            paths.version_migration_path("snapshot-1").unwrap(),
            dir.join("version-migrations").join("snapshot-1")
        );
    }

    #[test]
    fn recovery_path_rejects_directory_traversal_and_absolute_paths() {
        let dir = temp_dir();
        let paths = LibraryPaths::new(&dir).unwrap();

        assert!(matches!(
            paths.recovery_path("../outside"),
            Err(AppError::InvalidMaterialId(_))
        ));
        assert!(matches!(
            paths.recovery_path("/outside"),
            Err(AppError::InvalidMaterialId(_))
        ));
        assert!(matches!(
            paths.recovery_path("nested/material"),
            Err(AppError::InvalidMaterialId(_))
        ));
    }

    #[test]
    fn missing_source_surfaces_error() {
        let dir = temp_dir();
        let error = stream_copy_with_fingerprint(&dir.join("missing.bin"), &dir.join("out.bin"))
            .unwrap_err();
        assert!(matches!(error, AppError::Io(_)));
    }

    #[test]
    fn atomic_write_export_file_overwrites_selected_export_with_unicode_content() {
        let dir = temp_dir();
        let path = dir.join("notes.md");
        atomic_write_export_file(&path, "旧内容".as_bytes()).unwrap();
        atomic_write_export_file(&path, "# 新内容\n\n中文批注".as_bytes()).unwrap();

        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "# 新内容\n\n中文批注"
        );
    }
}
