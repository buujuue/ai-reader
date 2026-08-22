use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{classify_io_error, AppError};
use crate::fs::LibraryPaths;

pub const BACKUP_FORMAT_VERSION: u32 = 1;
const COPY_BUFFER_SIZE: usize = 64 * 1024;
const TAR_BLOCK_SIZE: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifestEntry {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMaterial {
    pub id: String,
    pub source_file_name: String,
    pub fingerprint: String,
    pub trashed: bool,
    pub has_cover: bool,
    #[serde(default)]
    pub has_source_cover: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format_version: u32,
    pub created_at: u64,
    pub encrypted: bool,
    pub entries: Vec<BackupManifestEntry>,
    pub materials: Vec<BackupMaterial>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResult {
    pub destination_path: String,
    pub entry_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreResult {
    pub material_count: u64,
    pub entry_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreState {
    operation_id: String,
    stage_dir: PathBuf,
    snapshot_dir: PathBuf,
    old_dir: PathBuf,
    phase: RestorePhase,
    result: BackupRestoreResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RestorePhase {
    Prepared,
    Switching,
    Completed,
}

struct BackupSourceEntry {
    manifest: BackupManifestEntry,
    source_path: PathBuf,
}

/// 完整书库备份 Repository。数据库快照、托管文件与 manifest 都由 Rust
/// 负责，前端只能通过 typed Tauri 命令指定导出目标路径。
pub struct BackupRepository<'a> {
    connection: &'a Connection,
}

impl<'a> BackupRepository<'a> {
    pub fn new(connection: &'a Connection) -> Self {
        Self { connection }
    }

    pub fn export(
        &self,
        paths: &LibraryPaths,
        destination: &Path,
    ) -> Result<BackupExportResult, AppError> {
        if destination.as_os_str().is_empty() {
            return Err(AppError::BackupArchive("备份目标路径不能为空".to_string()));
        }
        if destination.exists() {
            return Err(AppError::BackupDestinationExists(
                destination.display().to_string(),
            ));
        }
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        if !parent.is_dir() {
            return Err(AppError::BackupArchive(format!(
                "备份目标目录不存在:{}",
                parent.display()
            )));
        }

        let snapshot_path = paths
            .stash_dir
            .join(format!(".backup-db-{}.sqlite", uuid::Uuid::new_v4()));
        let temp_archive = parent.join(format!(
            ".{}-{}.tmp",
            destination
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("ai-reader-backup"),
            uuid::Uuid::new_v4()
        ));

        let result = (|| {
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_archive)
                .map_err(classify_io_error)?;
            self.connection.backup("main", &snapshot_path, None)?;
            let snapshot = Connection::open(&snapshot_path)?;
            let (database_entry, mut file_entries, materials) =
                collect_backup_entries(&snapshot, &snapshot_path, paths)?;
            file_entries.insert(0, database_entry);

            let manifest = BackupManifest {
                format_version: BACKUP_FORMAT_VERSION,
                created_at: now_millis(),
                encrypted: false,
                entries: file_entries
                    .iter()
                    .map(|entry| entry.manifest.clone())
                    .collect(),
                materials,
            };
            let manifest_bytes =
                serde_json::to_vec_pretty(&manifest).map_err(AppError::BackupManifestSerialize)?;
            let total_bytes = manifest_bytes.len() as u64
                + file_entries
                    .iter()
                    .map(|entry| entry.manifest.size)
                    .sum::<u64>();

            write_archive(file, &manifest_bytes, &file_entries)?;
            std::fs::rename(&temp_archive, destination).map_err(classify_io_error)?;

            Ok(BackupExportResult {
                destination_path: destination.display().to_string(),
                entry_count: file_entries.len() as u64 + 1,
                total_bytes,
            })
        })();

        let _ = std::fs::remove_file(&snapshot_path);
        if result.is_err() {
            let _ = std::fs::remove_file(&temp_archive);
        }
        result
    }

    pub fn prepare_restore(
        connection: &Connection,
        paths: &LibraryPaths,
        source: &Path,
    ) -> Result<(), AppError> {
        if !source.is_file() {
            return Err(AppError::BackupValidation(format!(
                "备份文件不存在:{}",
                source.display()
            )));
        }
        let state_path = restore_state_path(paths);
        if state_path.exists() {
            return Err(AppError::BackupRestore(
                "已有未完成的书库恢复操作".to_string(),
            ));
        }

        let operation_id = uuid::Uuid::new_v4().to_string();
        let operation_root = paths.stash_dir.join(format!(".restore-{operation_id}"));
        let stage_dir = operation_root.join("staged");
        let snapshot_dir = operation_root.join("snapshot");
        let old_dir = operation_root.join("old");

        let result = (|| {
            let (manifest, manifest_bytes_len) = read_manifest(source)?;
            validate_manifest(&manifest)?;
            let current_bytes = estimate_current_library_bytes(paths)?;
            let staged_bytes = manifest.entries.iter().map(|entry| entry.size).sum::<u64>();
            let required_bytes = staged_bytes
                .saturating_add(current_bytes)
                .saturating_add(manifest_bytes_len as u64)
                .saturating_add(1024 * 1024);
            ensure_disk_space(&paths.app_data_dir, required_bytes)?;

            std::fs::create_dir_all(&stage_dir).map_err(classify_io_error)?;
            stage_archive(source, &stage_dir, &manifest)?;
            validate_staged_library(&stage_dir, &manifest)?;

            create_current_snapshot(connection, paths, &snapshot_dir)?;
            std::fs::create_dir_all(&old_dir).map_err(classify_io_error)?;

            let result = BackupRestoreResult {
                material_count: manifest.materials.len() as u64,
                entry_count: manifest.entries.len() as u64 + 1,
                total_bytes: manifest_bytes_len as u64 + staged_bytes,
            };
            write_restore_state(
                paths,
                &RestoreState {
                    operation_id,
                    stage_dir,
                    snapshot_dir,
                    old_dir,
                    phase: RestorePhase::Prepared,
                    result,
                },
            )
        })();

        if result.is_err() {
            let _ = std::fs::remove_dir_all(&operation_root);
        }
        result
    }
}

pub fn complete_restore(paths: &LibraryPaths) -> Result<BackupRestoreResult, AppError> {
    let mut state = read_restore_state(paths)?;
    if state.phase != RestorePhase::Prepared {
        return Err(AppError::BackupRestore(
            "恢复操作不处于待切换状态".to_string(),
        ));
    }
    state.phase = RestorePhase::Switching;
    write_restore_state(paths, &state)?;

    swap_database_and_directories(paths, &state)?;
    Ok(state.result)
}

pub fn finish_restore(paths: &LibraryPaths) -> Result<(), AppError> {
    let mut state = read_restore_state(paths)?;
    if state.phase != RestorePhase::Switching {
        return Err(AppError::BackupRestore(
            "恢复操作不处于切换状态".to_string(),
        ));
    }
    state.phase = RestorePhase::Completed;
    write_restore_state(paths, &state)?;
    // 新数据库已经打开后，清理失败不应把一次成功恢复报告成失败；完成状态会在下次启动继续清理。
    let _ = cleanup_restore_state(paths, &state);
    Ok(())
}

pub fn rollback_restore(paths: &LibraryPaths) -> Result<(), AppError> {
    let state = match read_restore_state(paths) {
        Ok(state) => state,
        Err(AppError::BackupRecoveryState(message)) if message == "没有待恢复状态" => {
            return Ok(())
        }
        Err(error) => return Err(error),
    };

    match state.phase {
        RestorePhase::Prepared | RestorePhase::Completed => cleanup_restore_state(paths, &state),
        RestorePhase::Switching => {
            restore_old_paths(paths, &state)?;
            cleanup_restore_state(paths, &state)
        }
    }
}

pub fn recover_library_restore(paths: &LibraryPaths) -> Result<(), AppError> {
    let state_path = restore_state_path(paths);
    if !state_path.exists() {
        return Ok(());
    }
    let state = read_restore_state(paths)?;
    match state.phase {
        RestorePhase::Prepared | RestorePhase::Switching => rollback_restore(paths),
        RestorePhase::Completed => cleanup_restore_state(paths, &state),
    }
}

fn restore_state_path(paths: &LibraryPaths) -> PathBuf {
    paths.stash_dir.join("library-restore.json")
}

fn write_restore_state(paths: &LibraryPaths, state: &RestoreState) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| AppError::BackupRecoveryState(error.to_string()))?;
    crate::fs::atomic_write(&restore_state_path(paths), &bytes)
}

fn read_restore_state(paths: &LibraryPaths) -> Result<RestoreState, AppError> {
    let path = restore_state_path(paths);
    if !path.exists() {
        return Err(AppError::BackupRecoveryState("没有待恢复状态".to_string()));
    }
    let bytes = std::fs::read(&path).map_err(classify_io_error)?;
    serde_json::from_slice(&bytes).map_err(|error| AppError::BackupRecoveryState(error.to_string()))
}

fn cleanup_restore_state(paths: &LibraryPaths, state: &RestoreState) -> Result<(), AppError> {
    if let Some(operation_root) = state.stage_dir.parent() {
        match std::fs::remove_dir_all(operation_root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(classify_io_error(error)),
        }
    }
    let state_path = restore_state_path(paths);
    if state_path.exists() {
        std::fs::remove_file(state_path).map_err(classify_io_error)?;
    }
    Ok(())
}

fn read_manifest(source: &Path) -> Result<(BackupManifest, usize), AppError> {
    let mut file = File::open(source).map_err(classify_io_error)?;
    let header = read_tar_header(&mut file)?.ok_or_else(|| {
        AppError::BackupValidation("备份归档为空，缺少 manifest.json".to_string())
    })?;
    if header.name != "manifest.json" {
        return Err(AppError::BackupValidation(
            "备份归档第一项必须是 manifest.json".to_string(),
        ));
    }
    let bytes = read_tar_payload(&mut file, header.size, "manifest.json")?;
    let manifest = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::BackupValidation(format!("manifest.json 无法解析:{error}")))?;
    Ok((manifest, bytes.len()))
}

#[derive(Debug)]
struct TarHeader {
    name: String,
    size: u64,
    kind: u8,
}

fn read_tar_header(reader: &mut File) -> Result<Option<TarHeader>, AppError> {
    let mut header = [0u8; TAR_BLOCK_SIZE];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(AppError::BackupValidation("tar 归档被截断".to_string()))
        }
        Err(error) => return Err(classify_io_error(error)),
    }
    if header.iter().all(|byte| *byte == 0) {
        let mut end = [0u8; TAR_BLOCK_SIZE];
        reader
            .read_exact(&mut end)
            .map_err(|_| AppError::BackupValidation("tar 归档缺少结束块".to_string()))?;
        if !end.iter().all(|byte| *byte == 0) {
            return Err(AppError::BackupValidation(
                "tar 归档结束标记损坏".to_string(),
            ));
        }
        let mut trailing = [0u8; 1];
        if reader.read(&mut trailing).map_err(classify_io_error)? != 0 {
            return Err(AppError::BackupValidation(
                "tar 归档包含结束标记后的数据".to_string(),
            ));
        }
        return Ok(None);
    }

    let expected_checksum = parse_octal(&header[148..156])?;
    let mut checksum_header = header;
    checksum_header[148..156].fill(b' ');
    let actual_checksum = checksum_header
        .iter()
        .map(|byte| u64::from(*byte))
        .sum::<u64>();
    if expected_checksum != actual_checksum {
        return Err(AppError::BackupValidation(
            "tar header 校验和错误".to_string(),
        ));
    }
    let name_end = header[..100]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(100);
    let name = std::str::from_utf8(&header[..name_end])
        .map_err(|_| AppError::BackupValidation("tar 路径不是 UTF-8".to_string()))?
        .to_string();
    let kind = header[156];
    if kind != b'0' && kind != 0 {
        return Err(AppError::BackupValidation(format!(
            "tar 包含不支持的条目类型:{name}"
        )));
    }
    Ok(Some(TarHeader {
        name,
        size: parse_octal(&header[124..136])?,
        kind,
    }))
}

fn parse_octal(bytes: &[u8]) -> Result<u64, AppError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::BackupValidation("tar 数字字段不是 UTF-8".to_string()))?
        .trim_matches(|character| character == '\0' || character == ' ');
    if text.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(text, 8)
        .map_err(|_| AppError::BackupValidation("tar 数字字段无效".to_string()))
}

fn read_tar_payload(reader: &mut File, size: u64, name: &str) -> Result<Vec<u8>, AppError> {
    if size > 16 * 1024 * 1024 {
        return Err(AppError::BackupValidation(format!(
            "{name} 超过 manifest 大小限制"
        )));
    }
    let mut bytes = vec![0u8; size as usize];
    reader
        .read_exact(&mut bytes)
        .map_err(|_| AppError::BackupValidation(format!("归档条目内容被截断:{name}")))?;
    skip_tar_padding(reader, size)
        .map(|_| bytes)
        .map_err(|error| match error {
            AppError::BackupValidation(_) => error,
            other => other,
        })
}

fn skip_tar_padding(reader: &mut File, size: u64) -> Result<(), AppError> {
    let padding = (TAR_BLOCK_SIZE as u64 - (size % TAR_BLOCK_SIZE as u64)) % TAR_BLOCK_SIZE as u64;
    if padding == 0 {
        return Ok(());
    }
    let mut bytes = [0u8; TAR_BLOCK_SIZE];
    reader
        .read_exact(&mut bytes[..padding as usize])
        .map_err(|_| AppError::BackupValidation("tar padding 被截断".to_string()))
}

fn validate_manifest(manifest: &BackupManifest) -> Result<(), AppError> {
    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err(AppError::BackupValidation(format!(
            "不支持的备份版本:{}",
            manifest.format_version
        )));
    }
    if manifest.encrypted {
        return Err(AppError::BackupValidation("暂不支持加密备份".to_string()));
    }

    let mut materials = HashSet::new();
    for material in &manifest.materials {
        validate_material_id(&material.id)?;
        if material.fingerprint.is_empty() || material.source_file_name.is_empty() {
            return Err(AppError::BackupValidation(format!(
                "书籍元数据不完整:{}",
                material.id
            )));
        }
        if !materials.insert(material.id.clone()) {
            return Err(AppError::BackupValidation(format!(
                "manifest 重复书籍:{}",
                material.id
            )));
        }
    }

    let mut paths = HashSet::new();
    let mut database_count = 0;
    let mut material_ids = HashSet::new();
    let mut cover_ids = HashSet::new();
    let mut source_cover_ids = HashSet::new();
    for entry in &manifest.entries {
        if !paths.insert(&entry.path) {
            return Err(AppError::BackupValidation(format!(
                "manifest 重复路径:{}",
                entry.path
            )));
        }
        if entry.size == 0 && entry.kind == "database" {
            return Err(AppError::BackupValidation("数据库条目为空".to_string()));
        }
        match entry.kind.as_str() {
            "database" if entry.path == "database/ai-reader.db" => {
                database_count += 1;
                if entry.material_id.is_some() {
                    return Err(AppError::BackupValidation(
                        "数据库条目不应包含 materialId".to_string(),
                    ));
                }
            }
            "material" => {
                let id = entry
                    .path
                    .strip_prefix("library/")
                    .ok_or_else(|| AppError::BackupValidation("书籍路径不合法".to_string()))?;
                validate_material_id(id)?;
                if entry.material_id.as_deref() != Some(id)
                    || !materials.contains(id)
                    || !material_ids.insert(id.to_string())
                {
                    return Err(AppError::BackupValidation(format!(
                        "书籍条目与 manifest 不匹配:{id}"
                    )));
                }
            }
            "cover" => {
                let id = entry
                    .path
                    .strip_prefix("covers/")
                    .ok_or_else(|| AppError::BackupValidation("封面路径不合法".to_string()))?;
                validate_material_id(id)?;
                if entry.material_id.as_deref() != Some(id)
                    || !materials.contains(id)
                    || !cover_ids.insert(id.to_string())
                {
                    return Err(AppError::BackupValidation(format!(
                        "封面条目与 manifest 不匹配:{id}"
                    )));
                }
            }
            "source-cover" => {
                let id = entry
                    .path
                    .strip_prefix("source-covers/")
                    .ok_or_else(|| AppError::BackupValidation("来源封面路径不合法".to_string()))?;
                validate_material_id(id)?;
                if entry.material_id.as_deref() != Some(id)
                    || !materials.contains(id)
                    || !source_cover_ids.insert(id.to_string())
                {
                    return Err(AppError::BackupValidation(format!(
                        "来源封面条目与 manifest 不匹配:{id}"
                    )));
                }
            }
            _ => {
                return Err(AppError::BackupValidation(format!(
                    "未知或不安全的 manifest 条目:{}",
                    entry.path
                )))
            }
        }
    }
    if database_count != 1 || material_ids.len() != materials.len() {
        return Err(AppError::BackupValidation(
            "manifest 缺少数据库或书籍条目".to_string(),
        ));
    }
    for material in manifest.materials.iter() {
        let has_cover = cover_ids.contains(&material.id);
        if has_cover != material.has_cover {
            return Err(AppError::BackupValidation(format!(
                "封面条目标记不一致:{}",
                material.id
            )));
        }
        if source_cover_ids.contains(&material.id) != material.has_source_cover {
            return Err(AppError::BackupValidation(format!(
                "来源封面条目标记不一致:{}",
                material.id
            )));
        }
    }
    Ok(())
}

fn validate_material_id(material_id: &str) -> Result<(), AppError> {
    let mut components = Path::new(material_id).components();
    let valid = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !material_id.is_empty();
    if valid {
        Ok(())
    } else {
        Err(AppError::BackupValidation(format!(
            "书籍标识不安全:{material_id}"
        )))
    }
}

fn stage_archive(
    source: &Path,
    stage_dir: &Path,
    manifest: &BackupManifest,
) -> Result<(), AppError> {
    let mut expected = HashMap::new();
    for entry in &manifest.entries {
        expected.insert(entry.path.as_str(), entry);
    }
    let mut seen = HashSet::new();
    let mut file = File::open(source).map_err(classify_io_error)?;
    let first = read_tar_header(&mut file)?
        .ok_or_else(|| AppError::BackupValidation("备份归档缺少 manifest.json".to_string()))?;
    if first.name != "manifest.json" {
        return Err(AppError::BackupValidation(
            "备份归档第一项必须是 manifest.json".to_string(),
        ));
    }
    let _ = read_tar_payload(&mut file, first.size, &first.name)?;

    while let Some(header) = read_tar_header(&mut file)? {
        if header.name == "manifest.json" {
            return Err(AppError::BackupValidation(
                "manifest.json 不能重复出现".to_string(),
            ));
        }
        let entry = expected.get(header.name.as_str()).ok_or_else(|| {
            AppError::BackupValidation(format!("归档包含 manifest 未声明的条目:{}", header.name))
        })?;
        if header.kind != b'0' && header.kind != 0 {
            return Err(AppError::BackupValidation(format!(
                "归档条目类型不受支持:{}",
                header.name
            )));
        }
        if header.size != entry.size {
            return Err(AppError::BackupValidation(format!(
                "条目大小不匹配:{}",
                header.name
            )));
        }
        let target = staged_entry_path(stage_dir, entry)?;
        if !seen.insert(entry.path.as_str()) {
            return Err(AppError::BackupValidation(format!(
                "归档条目重复:{}",
                entry.path
            )));
        }
        let parent = target
            .parent()
            .ok_or_else(|| AppError::BackupValidation("暂存路径没有父目录".to_string()))?;
        std::fs::create_dir_all(parent).map_err(classify_io_error)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(classify_io_error)?;
        let mut hasher = Sha256::new();
        let mut remaining = header.size;
        let mut buffer = [0u8; COPY_BUFFER_SIZE];
        while remaining > 0 {
            let requested = remaining.min(COPY_BUFFER_SIZE as u64) as usize;
            file.read_exact(&mut buffer[..requested]).map_err(|_| {
                AppError::BackupValidation(format!("归档条目内容被截断:{}", header.name))
            })?;
            output
                .write_all(&buffer[..requested])
                .map_err(classify_io_error)?;
            hasher.update(&buffer[..requested]);
            remaining -= requested as u64;
        }
        output.flush().map_err(classify_io_error)?;
        skip_tar_padding(&mut file, header.size)?;
        if hex(&hasher.finalize()) != entry.sha256 {
            return Err(AppError::BackupValidation(format!(
                "条目指纹不匹配:{}",
                entry.path
            )));
        }
    }

    if seen.len() != expected.len() {
        let missing = expected
            .keys()
            .find(|path| !seen.contains(*path))
            .copied()
            .unwrap_or("unknown");
        return Err(AppError::BackupValidation(format!(
            "归档缺少 manifest 条目:{missing}"
        )));
    }
    Ok(())
}

fn staged_entry_path(stage_dir: &Path, entry: &BackupManifestEntry) -> Result<PathBuf, AppError> {
    match entry.kind.as_str() {
        "database" if entry.path == "database/ai-reader.db" => {
            Ok(stage_dir.join("database").join("ai-reader.db"))
        }
        "material" => {
            let id = entry
                .path
                .strip_prefix("library/")
                .ok_or_else(|| AppError::BackupValidation("书籍暂存路径不合法".to_string()))?;
            validate_material_id(id)?;
            Ok(stage_dir.join("library").join(id))
        }
        "cover" => {
            let id = entry
                .path
                .strip_prefix("covers/")
                .ok_or_else(|| AppError::BackupValidation("封面暂存路径不合法".to_string()))?;
            validate_material_id(id)?;
            Ok(stage_dir.join("covers").join(id))
        }
        "source-cover" => {
            let id = entry
                .path
                .strip_prefix("source-covers/")
                .ok_or_else(|| AppError::BackupValidation("来源封面暂存路径不合法".to_string()))?;
            validate_material_id(id)?;
            Ok(stage_dir.join("source-covers").join(id))
        }
        _ => Err(AppError::BackupValidation(format!(
            "无法暂存未知条目:{}",
            entry.path
        ))),
    }
}

fn validate_staged_library(stage_dir: &Path, manifest: &BackupManifest) -> Result<(), AppError> {
    for material in &manifest.materials {
        let entry = manifest
            .entries
            .iter()
            .find(|entry| {
                entry.kind == "material" && entry.material_id.as_deref() == Some(&material.id)
            })
            .ok_or_else(|| AppError::BackupValidation(format!("缺少书籍条目:{}", material.id)))?;
        if material.fingerprint != entry.sha256 {
            return Err(AppError::BackupValidation(format!(
                "书籍完整指纹与文件指纹不一致:{}",
                material.id
            )));
        }
        if material.has_source_cover && !stage_dir.join("source-covers").join(&material.id).is_file() {
            return Err(AppError::BackupValidation(format!(
                "缺少来源封面:{}",
                material.id
            )));
        }
    }
    let database_path = stage_dir.join("database").join("ai-reader.db");
    let database =
        Connection::open_with_flags(&database_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| AppError::BackupValidation(format!("数据库无法打开:{error}")))?;
    let integrity: String = database
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| AppError::BackupValidation(format!("数据库完整性检查失败:{error}")))?;
    if integrity != "ok" {
        return Err(AppError::BackupValidation(format!(
            "数据库完整性检查结果:{integrity}"
        )));
    }
    let schema_version: i64 = database
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| AppError::BackupValidation(format!("数据库版本无法读取:{error}")))?;
    let current_schema_version = crate::db::MIGRATIONS
        .last()
        .map(|(version, _)| *version)
        .unwrap_or_default();
    if schema_version > current_schema_version {
        return Err(AppError::BackupValidation(format!(
            "数据库版本更新于当前应用:{schema_version}"
        )));
    }
    for table in [
        "schema_migrations",
        "workspace_state",
        "materials",
        "material_overrides",
        "annotations",
    ] {
        let exists: bool = database.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::BackupValidation(format!(
                "数据库缺少必需表:{table}"
            )));
        }
    }

    let mut statement = database.prepare(
        "SELECT m.id, m.source_file_name, m.fingerprint, m.deleted_at,
                EXISTS(SELECT 1 FROM material_overrides o
                       WHERE o.material_id = m.id AND o.cover_source IS NOT NULL)
         FROM materials m WHERE m.status = 'ready' ORDER BY m.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?.is_some(),
            row.get::<_, bool>(4)?,
        ))
    })?;
    let mut actual = HashMap::new();
    for row in rows {
        let (id, source_file_name, fingerprint, trashed, has_cover) = row?;
        if actual
            .insert(
                id.clone(),
                (source_file_name, fingerprint, trashed, has_cover),
            )
            .is_some()
        {
            return Err(AppError::BackupValidation(format!(
                "数据库包含重复书籍:{id}"
            )));
        }
    }
    if actual.len() != manifest.materials.len() {
        return Err(AppError::BackupValidation(
            "数据库书籍数量与 manifest 不一致".to_string(),
        ));
    }
    for material in &manifest.materials {
        let Some((source_file_name, fingerprint, trashed, has_cover)) = actual.get(&material.id)
        else {
            return Err(AppError::BackupValidation(format!(
                "数据库缺少书籍:{}",
                material.id
            )));
        };
        if source_file_name != &material.source_file_name
            || fingerprint != &material.fingerprint
            || trashed != &material.trashed
            || has_cover != &material.has_cover
        {
            return Err(AppError::BackupValidation(format!(
                "书籍元数据指纹或状态不一致:{}",
                material.id
            )));
        }
    }
    Ok(())
}

fn create_current_snapshot(
    connection: &Connection,
    paths: &LibraryPaths,
    snapshot_dir: &Path,
) -> Result<(), AppError> {
    std::fs::create_dir_all(snapshot_dir.join("database")).map_err(classify_io_error)?;
    std::fs::create_dir_all(snapshot_dir.join("library")).map_err(classify_io_error)?;
    std::fs::create_dir_all(snapshot_dir.join("covers")).map_err(classify_io_error)?;
    std::fs::create_dir_all(snapshot_dir.join("source-covers")).map_err(classify_io_error)?;
    connection.backup(
        "main",
        snapshot_dir.join("database").join("ai-reader.db"),
        None,
    )?;
    copy_tree(&paths.managed_dir, &snapshot_dir.join("library"))?;
    copy_tree(&paths.covers_dir, &snapshot_dir.join("covers"))?;
    copy_tree(
        &paths.source_covers_dir,
        &snapshot_dir.join("source-covers"),
    )?;
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<u64, AppError> {
    std::fs::create_dir_all(destination).map_err(classify_io_error)?;
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(source).map_err(classify_io_error)? {
        let entry = entry.map_err(classify_io_error)?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = entry.metadata().map_err(classify_io_error)?;
        if metadata.is_file() {
            crate::fs::stream_copy_with_fingerprint(&source_path, &destination_path)?;
            total = total.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            total = total.saturating_add(copy_tree(&source_path, &destination_path)?);
        } else {
            return Err(AppError::BackupRestore(format!(
                "当前书库包含不支持的文件类型:{}",
                source_path.display()
            )));
        }
    }
    Ok(total)
}

fn estimate_current_library_bytes(paths: &LibraryPaths) -> Result<u64, AppError> {
    let database = std::fs::metadata(paths.database_path()).map_err(classify_io_error)?;
    let mut total = database.len();
    total = total.saturating_add(directory_size(&paths.managed_dir)?);
    total = total.saturating_add(directory_size(&paths.covers_dir)?);
    total = total.saturating_add(directory_size(&paths.source_covers_dir)?);
    Ok(total)
}

fn directory_size(path: &Path) -> Result<u64, AppError> {
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(path).map_err(classify_io_error)? {
        let entry = entry.map_err(classify_io_error)?;
        let metadata = entry.metadata().map_err(classify_io_error)?;
        if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            total = total.saturating_add(directory_size(&entry.path())?);
        }
    }
    Ok(total)
}

fn ensure_disk_space(path: &Path, required: u64) -> Result<(), AppError> {
    ensure_available_space(available_space(path), required)
}

fn ensure_available_space(available: Option<u64>, required: u64) -> Result<(), AppError> {
    if let Some(available) = available {
        if available < required {
            return Err(AppError::DiskFull(format!(
                "需要至少 {required} 字节，可用 {available} 字节"
            )));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn available_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            directory_name: *const u16,
            free_bytes_available: *mut u64,
            total_number_of_bytes: *mut u64,
            total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }

    let mut directory: Vec<u16> = path.as_os_str().encode_wide().collect();
    directory.push(0);
    let mut free = 0;
    let mut total = 0;
    let mut total_free = 0;
    let success =
        unsafe { GetDiskFreeSpaceExW(directory.as_ptr(), &mut free, &mut total, &mut total_free) }
            != 0;
    success.then_some(free)
}

#[cfg(unix)]
fn available_space(path: &Path) -> Option<u64> {
    use std::ffi::CString;

    #[repr(C)]
    struct StatVfs {
        block_size: u64,
        fragment_size: u64,
        blocks: u64,
        blocks_free: u64,
        blocks_available: u64,
        files: u64,
        files_free: u64,
        files_available: u64,
        filesystem_id: u64,
        flags: u64,
        name_max: u64,
        _spare: [u32; 6],
    }

    unsafe extern "C" {
        fn statvfs(path: *const std::ffi::c_char, buffer: *mut StatVfs) -> i32;
    }
    let path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<StatVfs>::uninit();
    let success = unsafe { statvfs(path.as_ptr(), stat.as_mut_ptr()) } == 0;
    if success {
        let stat = unsafe { stat.assume_init() };
        Some(stat.blocks_available.saturating_mul(stat.fragment_size))
    } else {
        None
    }
}

#[cfg(not(any(windows, unix)))]
fn available_space(_path: &Path) -> Option<u64> {
    None
}

fn swap_database_and_directories(
    paths: &LibraryPaths,
    state: &RestoreState,
) -> Result<(), AppError> {
    let old_database = state.old_dir.join("database").join("ai-reader.db");
    let old_library = state.old_dir.join("library");
    let old_covers = state.old_dir.join("covers");
    let old_source_covers = state.old_dir.join("source-covers");
    std::fs::create_dir_all(old_database.parent().unwrap()).map_err(classify_io_error)?;

    move_active_directory(&paths.managed_dir, &old_library)?;
    move_active_directory(&paths.covers_dir, &old_covers)?;
    move_active_directory(&paths.source_covers_dir, &old_source_covers)?;
    move_active_file(&paths.database_path(), &old_database)?;
    for suffix in ["-wal", "-shm"] {
        let active = PathBuf::from(format!("{}{}", paths.database_path().display(), suffix));
        let old = PathBuf::from(format!("{}{}", old_database.display(), suffix));
        if active.exists() {
            move_active_file(&active, &old)?;
        }
    }

    move_active_directory(&state.stage_dir.join("library"), &paths.managed_dir)?;
    move_active_directory(&state.stage_dir.join("covers"), &paths.covers_dir)?;
    move_active_directory(
        &state.stage_dir.join("source-covers"),
        &paths.source_covers_dir,
    )?;
    move_active_file(
        &state.stage_dir.join("database").join("ai-reader.db"),
        &paths.database_path(),
    )?;
    Ok(())
}

fn move_active_directory(source: &Path, destination: &Path) -> Result<(), AppError> {
    if destination.exists() {
        return Err(AppError::BackupRestore(format!(
            "切换目标已存在:{}",
            destination.display()
        )));
    }
    if !source.exists() {
        std::fs::create_dir_all(destination).map_err(classify_io_error)?;
        return Ok(());
    }
    std::fs::rename(source, destination).map_err(classify_io_error)
}

fn move_active_file(source: &Path, destination: &Path) -> Result<(), AppError> {
    if !source.exists() {
        return Err(AppError::BackupRestore(format!(
            "切换源文件不存在:{}",
            source.display()
        )));
    }
    if destination.exists() {
        return Err(AppError::BackupRestore(format!(
            "切换目标文件已存在:{}",
            destination.display()
        )));
    }
    std::fs::rename(source, destination).map_err(classify_io_error)
}

fn restore_old_paths(paths: &LibraryPaths, state: &RestoreState) -> Result<(), AppError> {
    restore_directory(&paths.managed_dir, &state.old_dir.join("library"))?;
    restore_directory(&paths.covers_dir, &state.old_dir.join("covers"))?;
    restore_directory(
        &paths.source_covers_dir,
        &state.old_dir.join("source-covers"),
    )?;
    restore_file(
        &paths.database_path(),
        &state.old_dir.join("database").join("ai-reader.db"),
    )?;
    for suffix in ["-wal", "-shm"] {
        let active = PathBuf::from(format!("{}{}", paths.database_path().display(), suffix));
        let old = PathBuf::from(format!(
            "{}{}",
            state
                .old_dir
                .join("database")
                .join("ai-reader.db")
                .display(),
            suffix
        ));
        restore_file(&active, &old)?;
    }
    Ok(())
}

fn restore_directory(active: &Path, old: &Path) -> Result<(), AppError> {
    if old.exists() {
        if active.exists() {
            std::fs::remove_dir_all(active).map_err(classify_io_error)?;
        }
        std::fs::rename(old, active).map_err(classify_io_error)?;
    } else if !active.exists() {
        std::fs::create_dir_all(active).map_err(classify_io_error)?;
    }
    Ok(())
}

fn restore_file(active: &Path, old: &Path) -> Result<(), AppError> {
    if old.exists() {
        if active.exists() {
            std::fs::remove_file(active).map_err(classify_io_error)?;
        }
        std::fs::rename(old, active).map_err(classify_io_error)?;
    }
    Ok(())
}

fn collect_backup_entries(
    snapshot: &Connection,
    snapshot_path: &Path,
    paths: &LibraryPaths,
) -> Result<
    (
        BackupSourceEntry,
        Vec<BackupSourceEntry>,
        Vec<BackupMaterial>,
    ),
    AppError,
> {
    let database_manifest =
        file_manifest_entry("database/ai-reader.db", "database", None, snapshot_path)?;
    let database_entry = BackupSourceEntry {
        manifest: database_manifest,
        source_path: snapshot_path.to_path_buf(),
    };

    let mut statement = snapshot.prepare(
        "SELECT m.id, m.source_file_name, m.fingerprint, m.deleted_at, o.cover_source
         FROM materials AS m
         LEFT JOIN material_overrides AS o ON o.material_id = m.id
         WHERE m.status = 'ready'
         ORDER BY m.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?.is_some(),
            row.get::<_, Option<String>>(4)?.is_some(),
        ))
    })?;

    let mut entries = Vec::new();
    let mut materials = Vec::new();
    for row in rows {
        let (id, source_file_name, fingerprint, trashed, has_cover) = row?;
        let managed_path = material_path(&paths.managed_dir, &id)?;
        let managed_manifest = file_manifest_entry(
            &format!("library/{id}"),
            "material",
            Some(id.clone()),
            &managed_path,
        )?;
        entries.push(BackupSourceEntry {
            manifest: managed_manifest,
            source_path: managed_path,
        });

        if has_cover {
            let cover_path = material_path(&paths.covers_dir, &id)?;
            let cover_manifest = file_manifest_entry(
                &format!("covers/{id}"),
                "cover",
                Some(id.clone()),
                &cover_path,
            )?;
            entries.push(BackupSourceEntry {
                manifest: cover_manifest,
                source_path: cover_path,
            });
        }

        let source_cover_path = material_path(&paths.source_covers_dir, &id)?;
        let has_source_cover = source_cover_path.is_file();
        if has_source_cover {
            let source_cover_manifest = file_manifest_entry(
                &format!("source-covers/{id}"),
                "source-cover",
                Some(id.clone()),
                &source_cover_path,
            )?;
            entries.push(BackupSourceEntry {
                manifest: source_cover_manifest,
                source_path: source_cover_path,
            });
        }

        materials.push(BackupMaterial {
            id,
            source_file_name,
            fingerprint,
            trashed,
            has_cover,
            has_source_cover,
        });
    }

    Ok((database_entry, entries, materials))
}

fn material_path(root: &Path, material_id: &str) -> Result<PathBuf, AppError> {
    let mut components = Path::new(material_id).components();
    let valid = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !material_id.is_empty();
    if !valid {
        return Err(AppError::InvalidMaterialId(material_id.to_string()));
    }
    Ok(root.join(material_id))
}

fn file_manifest_entry(
    path: &str,
    kind: &str,
    material_id: Option<String>,
    source_path: &Path,
) -> Result<BackupManifestEntry, AppError> {
    let (size, sha256) = inspect_file(source_path)?;
    Ok(BackupManifestEntry {
        path: path.to_string(),
        kind: kind.to_string(),
        size,
        sha256,
        material_id,
    })
}

fn inspect_file(path: &Path) -> Result<(u64, String), AppError> {
    let mut file = File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::ManagedFileMissing(path.display().to_string())
        } else {
            classify_io_error(error)
        }
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; COPY_BUFFER_SIZE];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(classify_io_error)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((size, hex(&hasher.finalize())))
}

fn write_archive<W: Write>(
    sink: W,
    manifest_bytes: &[u8],
    entries: &[BackupSourceEntry],
) -> Result<(), AppError> {
    let mut writer = TarWriter::new(sink);
    writer.append_bytes("manifest.json", manifest_bytes)?;
    for entry in entries {
        writer.append_file(entry)?;
    }
    writer.finish()
}

struct TarWriter<W: Write> {
    sink: W,
}

impl<W: Write> TarWriter<W> {
    fn new(sink: W) -> Self {
        Self { sink }
    }

    fn append_bytes(&mut self, name: &str, bytes: &[u8]) -> Result<(), AppError> {
        let header = tar_header(name, bytes.len() as u64)?;
        self.sink.write_all(&header).map_err(classify_io_error)?;
        self.sink.write_all(bytes).map_err(classify_io_error)?;
        write_padding(&mut self.sink, bytes.len() as u64)?;
        Ok(())
    }

    fn append_file(&mut self, entry: &BackupSourceEntry) -> Result<(), AppError> {
        let size = entry.manifest.size;
        let header = tar_header(&entry.manifest.path, size)?;
        self.sink.write_all(&header).map_err(classify_io_error)?;

        let mut file = File::open(&entry.source_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::BackupSourceChanged(entry.source_path.display().to_string())
            } else {
                classify_io_error(error)
            }
        })?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; COPY_BUFFER_SIZE];
        let mut remaining = size;
        while remaining > 0 {
            let requested = remaining.min(COPY_BUFFER_SIZE as u64) as usize;
            let read = file
                .read(&mut buffer[..requested])
                .map_err(classify_io_error)?;
            if read == 0 {
                return Err(AppError::BackupSourceChanged(
                    entry.source_path.display().to_string(),
                ));
            }
            self.sink
                .write_all(&buffer[..read])
                .map_err(classify_io_error)?;
            hasher.update(&buffer[..read]);
            remaining -= read as u64;
        }
        let mut extra = [0u8; 1];
        if file.read(&mut extra).map_err(classify_io_error)? != 0
            || hex(&hasher.finalize()) != entry.manifest.sha256
        {
            return Err(AppError::BackupSourceChanged(
                entry.source_path.display().to_string(),
            ));
        }
        write_padding(&mut self.sink, size)
    }

    fn finish(mut self) -> Result<(), AppError> {
        self.sink
            .write_all(&[0u8; TAR_BLOCK_SIZE * 2])
            .map_err(classify_io_error)?;
        self.sink.flush().map_err(classify_io_error)
    }
}

fn write_padding<W: Write>(sink: &mut W, size: u64) -> Result<(), AppError> {
    let padding = (TAR_BLOCK_SIZE as u64 - (size % TAR_BLOCK_SIZE as u64)) % TAR_BLOCK_SIZE as u64;
    if padding == 0 {
        return Ok(());
    }
    let zeros = [0u8; TAR_BLOCK_SIZE];
    sink.write_all(&zeros[..padding as usize])
        .map_err(classify_io_error)
}

fn tar_header(name: &str, size: u64) -> Result<[u8; TAR_BLOCK_SIZE], AppError> {
    let name_bytes = name.as_bytes();
    if name_bytes.len() > 100 {
        return Err(AppError::BackupArchive(format!("归档路径过长:{name}")));
    }
    let mut header = [0u8; TAR_BLOCK_SIZE];
    header[..name_bytes.len()].copy_from_slice(name_bytes);
    write_octal(&mut header[100..108], 0o644)?;
    write_octal(&mut header[108..116], 0)?;
    write_octal(&mut header[116..124], 0)?;
    write_octal(&mut header[124..136], size)?;
    write_octal(&mut header[136..148], 0)?;
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    header[265..297].copy_from_slice(b"ai-reader\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0");
    let checksum = header.iter().map(|byte| u32::from(*byte)).sum::<u32>();
    let checksum_text = format!("{checksum:06o}\0 ");
    header[148..156].copy_from_slice(checksum_text.as_bytes());
    Ok(header)
}

fn write_octal(target: &mut [u8], value: u64) -> Result<(), AppError> {
    let width = target.len() - 1;
    let limit = 8u64.pow(width as u32);
    if value >= limit {
        return Err(AppError::BackupArchive(format!(
            "归档字段超出 tar 限制:{value}"
        )));
    }
    let text = format!("{value:0width$o}", width = width);
    target[..width].copy_from_slice(text.as_bytes());
    target[width] = 0;
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{run_migrations, MIGRATIONS};
    use crate::fs::fingerprint_bytes;
    use rusqlite::params;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai-reader-backup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn setup() -> (Connection, LibraryPaths, PathBuf) {
        let mut connection = Connection::open_in_memory().unwrap();
        run_migrations(&mut connection, MIGRATIONS).unwrap();
        let root = temp_dir();
        let paths = LibraryPaths::new(&root).unwrap();
        let material_id = "material-1";
        let managed_content = vec![b'x'; 2 * 1024 * 1024];
        connection
            .execute(
                "INSERT INTO materials
                 (id, status, fingerprint, title, source_file_name, deleted_at)
                 VALUES (?1, 'ready', ?2, ?3, ?4, NULL)",
                params![
                    material_id,
                    fingerprint_bytes(&managed_content),
                    "示例书",
                    "book.epub"
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO material_overrides (material_id, cover_source)
                 VALUES (?1, ?2)",
                params![material_id, material_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspace_state (id, json) VALUES (1, ?1)",
                [r#"{"schemaVersion":7,"editorGroups":[{"views":[{"materialId":"material-1","location":{"kind":"epub","cfi":"epubcfi(/6/4)"}}]}],"globalReadingTypography":{"fontSize":20}}"#],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO annotations
                 (id, material_id, cfi, quote, before, after, document_version,
                  recovery_state, style, color, note, created_at, updated_at)
                 VALUES ('annotation-1', ?1, 'cfi', 'quote', '', '', 'fp',
                         'resolved', 'highlight', '#ffd54f', 'note', 1, 1)",
                [material_id],
            )
            .unwrap();
        std::fs::write(paths.managed_path(material_id), managed_content).unwrap();
        std::fs::write(paths.cover_path(material_id), b"cover").unwrap();
        std::fs::write(paths.recovery_path(material_id).unwrap(), b"do not backup").unwrap();
        (connection, paths, root)
    }

    fn read_tar_entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
        let mut offset = 0;
        let mut result = Vec::new();
        while offset + TAR_BLOCK_SIZE <= bytes.len() {
            let header = &bytes[offset..offset + TAR_BLOCK_SIZE];
            if header.iter().all(|byte| *byte == 0) {
                break;
            }
            let name = String::from_utf8_lossy(&header[..100])
                .trim_end_matches('\0')
                .to_string();
            let size_text = String::from_utf8_lossy(&header[124..136])
                .trim_matches('\0')
                .trim()
                .to_string();
            let size = u64::from_str_radix(&size_text, 8).unwrap() as usize;
            offset += TAR_BLOCK_SIZE;
            result.push((name, bytes[offset..offset + size].to_vec()));
            offset += size.div_ceil(TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
        }
        result
    }

    #[test]
    fn export_contains_versioned_manifest_sqlite_material_and_cover_but_not_recovery() {
        let (connection, paths, root) = setup();
        let destination = root.join("library.airbackup");

        let result = BackupRepository::new(&connection)
            .export(&paths, &destination)
            .unwrap();
        let archive = std::fs::read(&destination).unwrap();
        let entries = read_tar_entries(&archive);
        let names: Vec<_> = entries.iter().map(|(name, _)| name.as_str()).collect();

        assert_eq!(result.entry_count, 4);
        assert_eq!(
            names,
            vec![
                "manifest.json",
                "database/ai-reader.db",
                "library/material-1",
                "covers/material-1"
            ]
        );
        assert!(!names.iter().any(|name| name.contains("recovery")));

        let manifest: BackupManifest = serde_json::from_slice(&entries[0].1).unwrap();
        assert_eq!(manifest.format_version, BACKUP_FORMAT_VERSION);
        assert!(!manifest.encrypted);
        assert_eq!(
            manifest.materials[0].fingerprint,
            fingerprint_bytes(&entries[2].1)
        );
        assert_eq!(manifest.entries.len(), 3);
        assert_eq!(manifest.entries[1].size, 2 * 1024 * 1024);
        assert_eq!(manifest.entries[1].sha256, fingerprint_bytes(&entries[2].1));

        let snapshot_path = root.join("snapshot-check.db");
        std::fs::write(&snapshot_path, &entries[1].1).unwrap();
        let snapshot =
            Connection::open_with_flags(snapshot_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let count: i64 = snapshot
            .query_row("SELECT COUNT(*) FROM materials", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let workspace_json: String = snapshot
            .query_row("SELECT json FROM workspace_state WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(workspace_json.contains("epubcfi(/6/4)"));
        let annotation_count: i64 = snapshot
            .query_row("SELECT COUNT(*) FROM annotations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(annotation_count, 1);
    }

    #[test]
    fn export_and_restore_preserve_source_cover_as_a_separate_entry() {
        let (connection, paths, root) = setup();
        std::fs::write(paths.source_cover_path("material-1"), b"source-cover").unwrap();
        materialize_database(&connection, &paths);
        let destination = root.join("source-cover.airbackup");

        let result = BackupRepository::new(&connection)
            .export(&paths, &destination)
            .unwrap();
        let entries = read_tar_entries(&std::fs::read(&destination).unwrap());
        let names: Vec<_> = entries.iter().map(|(name, _)| name.as_str()).collect();

        assert_eq!(result.entry_count, 5);
        assert!(names.contains(&"covers/material-1"));
        assert!(names.contains(&"source-covers/material-1"));
        let manifest: BackupManifest = serde_json::from_slice(&entries[0].1).unwrap();
        assert!(manifest.materials[0].has_cover);
        assert!(manifest.materials[0].has_source_cover);

        let handle = crate::db::DatabaseHandle::new(connection);
        handle.restore_backup(&paths, &destination).unwrap();
        assert_eq!(
            std::fs::read(paths.source_cover_path("material-1")).unwrap(),
            b"source-cover"
        );
    }

    #[test]
    fn export_preserves_existing_destination_when_destination_exists() {
        let (connection, paths, root) = setup();
        let destination = root.join("library.airbackup");
        std::fs::write(&destination, b"existing").unwrap();

        let error = BackupRepository::new(&connection)
            .export(&paths, &destination)
            .unwrap_err();

        assert!(matches!(error, AppError::BackupDestinationExists(_)));
        assert_eq!(std::fs::read(destination).unwrap(), b"existing");
    }

    #[test]
    fn source_change_during_archive_is_classified() {
        let (_connection, paths, _root) = setup();
        let manifest = BackupManifestEntry {
            path: "library/material-1".to_string(),
            kind: "material".to_string(),
            size: 1,
            sha256: "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            material_id: Some("material-1".to_string()),
        };
        let entry = BackupSourceEntry {
            manifest,
            source_path: paths.managed_path("material-1"),
        };
        let manifest_bytes = b"{}";
        let mut sink = Vec::new();
        let error = write_archive(&mut sink, manifest_bytes, &[entry]).unwrap_err();
        assert!(matches!(error, AppError::BackupSourceChanged(_)));
    }

    #[test]
    fn missing_source_during_archive_is_classified() {
        let (_connection, paths, _root) = setup();
        let entry = BackupSourceEntry {
            manifest: BackupManifestEntry {
                path: "library/missing".to_string(),
                kind: "material".to_string(),
                size: 1,
                sha256: "0000000000000000000000000000000000000000000000000000000000000000"
                    .to_string(),
                material_id: Some("missing".to_string()),
            },
            source_path: paths.managed_path("missing"),
        };
        let error = write_archive(&mut Vec::new(), b"{}", &[entry]).unwrap_err();
        assert!(matches!(error, AppError::BackupSourceChanged(_)));
    }

    #[test]
    fn missing_source_during_export_removes_temporary_output() {
        let (connection, paths, root) = setup();
        std::fs::remove_file(paths.managed_path("material-1")).unwrap();
        let destination = root.join("library.airbackup");

        let error = BackupRepository::new(&connection)
            .export(&paths, &destination)
            .unwrap_err();

        assert!(matches!(error, AppError::ManagedFileMissing(_)));
        assert!(!destination.exists());
        let has_temporary_archive = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .any(|name| name.starts_with(".library.airbackup-") && name.ends_with(".tmp"));
        assert!(!has_temporary_archive);
    }

    #[test]
    fn write_failure_is_classified_as_disk_full() {
        struct FailingWriter;
        impl Write for FailingWriter {
            fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::StorageFull, "full"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let error = write_archive(FailingWriter, b"manifest", &[]).unwrap_err();
        assert!(matches!(error, AppError::DiskFull(_)));
    }

    #[test]
    fn tar_header_rejects_ustar_size_overflow() {
        let error = tar_header("library/large", 1u64 << 33).unwrap_err();
        assert!(matches!(error, AppError::BackupArchive(_)));
    }

    fn materialize_database(connection: &Connection, paths: &LibraryPaths) {
        connection
            .backup("main", paths.database_path(), None)
            .unwrap();
    }

    #[test]
    fn restore_replaces_database_and_managed_files_as_one_operation() {
        let (connection, paths, root) = setup();
        materialize_database(&connection, &paths);
        let source = root.join("source.airbackup");
        BackupRepository::new(&connection)
            .export(&paths, &source)
            .unwrap();

        connection
            .execute(
                "UPDATE materials SET title = '当前书库' WHERE id = 'material-1'",
                [],
            )
            .unwrap();
        std::fs::write(paths.managed_path("material-1"), b"current").unwrap();
        materialize_database(&connection, &paths);

        let handle = crate::db::DatabaseHandle::new(connection);
        let result = handle.restore_backup(&paths, &source).unwrap();

        assert_eq!(result.material_count, 1);
        assert_eq!(
            std::fs::read(paths.managed_path("material-1")).unwrap(),
            vec![b'x'; 2 * 1024 * 1024]
        );
        let title: String = handle
            .with_connection(|connection| {
                Ok(connection.query_row(
                    "SELECT title FROM materials WHERE id = 'material-1'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(title, "示例书");
        assert!(!paths.stash_dir.join("library-restore.json").exists());
    }

    #[test]
    fn corrupt_archive_is_rejected_before_current_library_changes() {
        let (connection, paths, root) = setup();
        materialize_database(&connection, &paths);
        let source = root.join("corrupt.airbackup");
        BackupRepository::new(&connection)
            .export(&paths, &source)
            .unwrap();
        let mut bytes = std::fs::read(&source).unwrap();
        let content_offset = bytes
            .iter()
            .position(|byte| *byte == b'x')
            .expect("material bytes should be present");
        bytes[content_offset] = b'y';
        std::fs::write(&source, bytes).unwrap();

        let handle = crate::db::DatabaseHandle::new(connection);
        let error = handle.restore_backup(&paths, &source).unwrap_err();

        assert!(matches!(error, AppError::BackupValidation(_)));
        assert_eq!(
            std::fs::read(paths.managed_path("material-1")).unwrap(),
            vec![b'x'; 2 * 1024 * 1024]
        );
        assert!(!paths.stash_dir.join("library-restore.json").exists());
    }

    #[test]
    fn failed_file_switch_rolls_back_the_current_library() {
        let (connection, paths, root) = setup();
        materialize_database(&connection, &paths);
        let source = root.join("source.airbackup");
        BackupRepository::new(&connection)
            .export(&paths, &source)
            .unwrap();
        BackupRepository::prepare_restore(&connection, &paths, &source).unwrap();
        let operation_root = std::fs::read_dir(&paths.stash_dir)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().starts_with(".restore-"))
            .unwrap()
            .path();
        std::fs::remove_file(
            operation_root
                .join("staged")
                .join("database")
                .join("ai-reader.db"),
        )
        .unwrap();
        drop(connection);

        let error = complete_restore(&paths).unwrap_err();
        assert!(matches!(
            error,
            AppError::BackupRestore(_) | AppError::Io(_)
        ));
        rollback_restore(&paths).unwrap();

        assert_eq!(
            std::fs::read(paths.managed_path("material-1")).unwrap(),
            vec![b'x'; 2 * 1024 * 1024]
        );
        assert_eq!(
            std::fs::read(paths.cover_path("material-1")).unwrap(),
            b"cover"
        );
        assert!(paths.database_path().is_file());
    }

    #[test]
    fn unknown_manifest_version_and_missing_archive_entry_are_rejected() {
        let mut manifest = BackupManifest {
            format_version: BACKUP_FORMAT_VERSION + 1,
            created_at: 0,
            encrypted: false,
            entries: Vec::new(),
            materials: Vec::new(),
        };
        assert!(matches!(
            validate_manifest(&manifest),
            Err(AppError::BackupValidation(_))
        ));

        manifest.format_version = BACKUP_FORMAT_VERSION;
        manifest.entries.push(BackupManifestEntry {
            path: "database/ai-reader.db".to_string(),
            kind: "database".to_string(),
            size: 1,
            sha256: "not-a-real-fingerprint".to_string(),
            material_id: None,
        });
        let error = stage_archive(
            Path::new("missing.airbackup"),
            Path::new("stage"),
            &manifest,
        )
        .unwrap_err();
        assert!(matches!(error, AppError::Io(_)));
    }

    #[test]
    fn insufficient_space_is_reported_before_staging() {
        let error = ensure_available_space(Some(99), 100).unwrap_err();
        assert!(matches!(error, AppError::DiskFull(_)));
        ensure_available_space(Some(100), 100).unwrap();
        ensure_available_space(None, u64::MAX).unwrap();
    }

    #[test]
    fn startup_recovery_rolls_back_an_interrupted_switch() {
        let (_connection, paths, root) = setup();
        let operation_root = paths.stash_dir.join(".restore-interrupted");
        let old_dir = operation_root.join("old");
        let stage_dir = operation_root.join("staged");
        let snapshot_dir = operation_root.join("snapshot");
        std::fs::create_dir_all(old_dir.join("database")).unwrap();
        std::fs::create_dir_all(old_dir.join("library")).unwrap();
        std::fs::create_dir_all(old_dir.join("covers")).unwrap();
        std::fs::write(old_dir.join("database").join("ai-reader.db"), b"old-db").unwrap();
        std::fs::write(old_dir.join("library").join("material-1"), b"old-book").unwrap();
        std::fs::write(old_dir.join("covers").join("material-1"), b"old-cover").unwrap();
        std::fs::write(paths.database_path(), b"new-db").unwrap();
        std::fs::write(paths.managed_path("material-1"), b"new-book").unwrap();
        std::fs::write(paths.cover_path("material-1"), b"new-cover").unwrap();
        let state = RestoreState {
            operation_id: "interrupted".to_string(),
            stage_dir,
            snapshot_dir,
            old_dir,
            phase: RestorePhase::Switching,
            result: BackupRestoreResult {
                material_count: 1,
                entry_count: 4,
                total_bytes: 3,
            },
        };
        write_restore_state(&paths, &state).unwrap();

        recover_library_restore(&paths).unwrap();

        assert_eq!(std::fs::read(paths.database_path()).unwrap(), b"old-db");
        assert_eq!(
            std::fs::read(paths.managed_path("material-1")).unwrap(),
            b"old-book"
        );
        assert_eq!(
            std::fs::read(paths.cover_path("material-1")).unwrap(),
            b"old-cover"
        );
        assert!(!paths.stash_dir.join("library-restore.json").exists());
        assert!(!root.join("unused").exists());
    }
}
