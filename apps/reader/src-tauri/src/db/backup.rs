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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResult {
    pub destination_path: String,
    pub entry_count: u64,
    pub total_bytes: u64,
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

        materials.push(BackupMaterial {
            id,
            source_file_name,
            fingerprint,
            trashed,
            has_cover,
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
        connection
            .execute(
                "INSERT INTO materials
                 (id, status, fingerprint, title, source_file_name, deleted_at)
                 VALUES (?1, 'ready', ?2, ?3, ?4, NULL)",
                params![
                    material_id,
                    "full-content-fingerprint",
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
        std::fs::write(paths.managed_path(material_id), vec![b'x'; 2 * 1024 * 1024]).unwrap();
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
            "full-content-fingerprint"
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
}
