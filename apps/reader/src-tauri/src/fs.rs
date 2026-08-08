use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{classify_io_error, AppError};

/// 应用托管文件布局。所有阅读材料与暂存文件都位于应用数据目录下的私有空间,
/// 外部原文件永不被修改或删除。
#[derive(Debug, Clone)]
pub struct LibraryPaths {
    pub stash_dir: PathBuf,
    pub managed_dir: PathBuf,
}

impl LibraryPaths {
    /// 在应用数据目录下创建暂存目录与托管书库目录。
    pub fn new(app_data_dir: &Path) -> Result<Self, AppError> {
        let stash_dir = app_data_dir.join("stash");
        let managed_dir = app_data_dir.join("library");
        std::fs::create_dir_all(&stash_dir)?;
        std::fs::create_dir_all(&managed_dir)?;
        Ok(Self {
            stash_dir,
            managed_dir,
        })
    }

    pub fn stash_path(&self, id: &str) -> PathBuf {
        self.stash_dir.join(id)
    }

    pub fn managed_path(&self, id: &str) -> PathBuf {
        self.managed_dir.join(id)
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
        writer.write_all(&buffer[..read]).map_err(classify_io_error)?;
    }
    writer.flush().map_err(classify_io_error)?;

    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 读取文件全部字节。仅用于把暂存文件交给 TypeScript 端检查格式与提取元数据,
/// 不用于大文件指纹计算(那部分始终走流式)。
pub fn read_file_bytes(path: &Path) -> Result<Vec<u8>, AppError> {
    std::fs::read(path).map_err(classify_io_error)
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
        assert_eq!(paths.stash_path("abc"), dir.join("stash").join("abc"));
        assert_eq!(paths.managed_path("abc"), dir.join("library").join("abc"));
    }

    #[test]
    fn missing_source_surfaces_error() {
        let dir = temp_dir();
        let error = stream_copy_with_fingerprint(&dir.join("missing.bin"), &dir.join("out.bin"))
            .unwrap_err();
        assert!(matches!(error, AppError::Io(_)));
    }
}
