use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek};
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;
use zip::ZipArchive;

const PREFETCH_PROTOCOL_VERSION: u32 = 1;
const MAX_PREFETCH_ENTRY_BYTES: u64 = 8 * 1024 * 1024;

const CAPABILITIES: [&str; 4] = [
    "container-prefetch",
    "opf-prefetch",
    "navigation-prefetch",
    "resource-sizes",
];

#[derive(Debug, thiserror::Error)]
pub enum NativeEpubError {
    #[error("unsupported:{0}")]
    Unsupported(String),
    #[error("corrupt:{0}")]
    Corrupt(String),
    #[error("budget:{0}")]
    Budget(String),
    #[error("io:{0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEpubParity {
    pub protocol_version: u32,
    pub semantic_source: &'static str,
    pub platform: &'static str,
    pub validated: bool,
    pub capabilities: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEpubPrefetch {
    pub parity: NativeEpubParity,
    pub opf_path: String,
    pub opf_bytes: Vec<u8>,
    pub nav_path: Option<String>,
    pub nav_bytes: Option<Vec<u8>>,
    pub ncx_path: Option<String>,
    pub ncx_bytes: Option<Vec<u8>>,
    pub sizes: HashMap<String, u64>,
}

#[derive(Default, Clone)]
struct ManifestItem {
    href: String,
    media_type: String,
    properties: String,
}

struct TocSources {
    nav_path: Option<String>,
    ncx_path: Option<String>,
}

/// 只做 ZIP 中央目录、入口 XML 和 NAV/NCX 的机械预取。
/// 不在 Rust 侧构造 BookDocument 或任何 CFI/导航对象。
pub fn prefetch(path: &Path) -> Result<NativeEpubPrefetch, NativeEpubError> {
    let file = File::open(path)?;
    let mut zip =
        ZipArchive::new(file).map_err(|error| NativeEpubError::Corrupt(format!("zip:{error}")))?;

    let rootfile_path = read_rootfile_path(&mut zip)?;
    let opf_bytes = read_entry(&mut zip, &rootfile_path, "OPF")?;
    let toc_sources = locate_toc_sources(&opf_bytes, &rootfile_path)?;
    let nav_bytes = toc_sources
        .nav_path
        .as_deref()
        .map(|path| read_entry(&mut zip, path, "NAV"))
        .transpose()?;
    let ncx_bytes = toc_sources
        .ncx_path
        .as_deref()
        .map(|path| read_entry(&mut zip, path, "NCX"))
        .transpose()?;

    let mut sizes = HashMap::with_capacity(zip.len());
    for index in 0..zip.len() {
        let entry = zip
            .by_index_raw(index)
            .map_err(|error| NativeEpubError::Corrupt(format!("zip entry:{error}")))?;
        if !entry.is_dir() {
            sizes.insert(entry.name().to_string(), entry.size());
        }
    }

    Ok(NativeEpubPrefetch {
        parity: NativeEpubParity {
            protocol_version: PREFETCH_PROTOCOL_VERSION,
            semantic_source: "foliate-js",
            platform: target_platform(),
            validated: parity_validated(),
            capabilities: CAPABILITIES.to_vec(),
        },
        opf_path: rootfile_path,
        opf_bytes,
        nav_path: toc_sources.nav_path,
        nav_bytes,
        ncx_path: toc_sources.ncx_path,
        ncx_bytes,
        sizes,
    })
}

fn read_entry<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    path: &str,
    label: &str,
) -> Result<Vec<u8>, NativeEpubError> {
    let entry_name = if zip.by_name(path).is_ok() {
        path.to_string()
    } else {
        let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy();
        if decoded == path {
            return Err(NativeEpubError::Corrupt(format!(
                "{label} {path}:entry not found"
            )));
        }
        decoded.into_owned()
    };
    let mut entry = zip.by_name(&entry_name).map_err(|error| {
        NativeEpubError::Corrupt(format!("{label} {path}:{error}"))
    })?;
    if entry.size() > MAX_PREFETCH_ENTRY_BYTES {
        return Err(NativeEpubError::Budget(format!("{label} {path} too large")));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| NativeEpubError::Corrupt(format!("{label} {path}:{error}")))?;
    Ok(bytes)
}

fn read_rootfile_path<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Result<String, NativeEpubError> {
    let bytes = read_entry(zip, "META-INF/container.xml", "container")?;
    let mut reader = xml_reader(&bytes);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if local_name(element.name().as_ref()) == b"rootfile" =>
            {
                if let Some(path) = attribute(&element, b"full-path") {
                    if path.is_empty() || path.starts_with('/') || path.contains("..") {
                        return Err(NativeEpubError::Corrupt(
                            "container rootfile path is unsafe".to_string(),
                        ));
                    }
                    return Ok(path);
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(NativeEpubError::Corrupt(format!("container XML:{error}"))),
            _ => {}
        }
        buffer.clear();
    }
    Err(NativeEpubError::Unsupported(
        "container has no rootfile".to_string(),
    ))
}

fn locate_toc_sources(opf_bytes: &[u8], opf_path: &str) -> Result<TocSources, NativeEpubError> {
    let mut reader = xml_reader(opf_bytes);
    let mut buffer = Vec::new();
    let mut manifest = HashMap::<String, ManifestItem>::new();
    let mut in_manifest = false;
    let mut in_spine = false;
    let mut spine_toc_id = None;
    let mut nav_href = None;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) => {
                let name = local_name(element.name().as_ref()).to_vec();
                if name == b"manifest" {
                    in_manifest = true;
                } else if name == b"spine" {
                    in_spine = true;
                    spine_toc_id = attribute(&element, b"toc");
                } else if in_manifest && name == b"item" {
                    record_manifest_item(&element, &mut manifest, &mut nav_href);
                }
            }
            Ok(Event::Empty(element)) => {
                let name = local_name(element.name().as_ref()).to_vec();
                if in_manifest && name == b"item" {
                    record_manifest_item(&element, &mut manifest, &mut nav_href);
                } else if name == b"spine" {
                    spine_toc_id = attribute(&element, b"toc");
                }
            }
            Ok(Event::End(element)) => {
                let element_name = element.name();
                let name = local_name(element_name.as_ref());
                if name == b"manifest" {
                    in_manifest = false;
                } else if name == b"spine" {
                    in_spine = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(NativeEpubError::Corrupt(format!("OPF XML:{error}"))),
            _ => {}
        }
        buffer.clear();
    }

    let ncx_href = spine_toc_id
        .as_ref()
        .and_then(|id| manifest.get(id))
        .map(|item| item.href.clone())
        .or_else(|| {
            manifest
                .values()
                .find(|item| item.media_type == "application/x-dtbncx+xml")
                .map(|item| item.href.clone())
        });

    let _ = in_spine;
    Ok(TocSources {
        nav_path: nav_href.map(|href| resolve_relative(opf_path, &href)),
        ncx_path: ncx_href.map(|href| resolve_relative(opf_path, &href)),
    })
}

fn record_manifest_item(
    element: &BytesStart<'_>,
    manifest: &mut HashMap<String, ManifestItem>,
    nav_href: &mut Option<String>,
) {
    let Some(id) = attribute(element, b"id") else {
        return;
    };
    let item = ManifestItem {
        href: attribute(element, b"href").unwrap_or_default(),
        media_type: attribute(element, b"media-type").unwrap_or_default(),
        properties: attribute(element, b"properties").unwrap_or_default(),
    };
    if nav_href.is_none()
        && item
            .properties
            .split_ascii_whitespace()
            .any(|value| value == "nav")
    {
        *nav_href = Some(item.href.clone());
    }
    manifest.insert(id, item);
}

fn attribute(element: &BytesStart<'_>, requested: &[u8]) -> Option<String> {
    element.attributes().flatten().find_map(|attribute| {
        (local_name(attribute.key.as_ref()) == requested)
            .then(|| String::from_utf8_lossy(attribute.value.as_ref()).into_owned())
    })
}

fn xml_reader(bytes: &[u8]) -> Reader<&[u8]> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    reader
}

fn resolve_relative(opf_path: &str, href: &str) -> String {
    let href = href.split(['?', '#']).next().unwrap_or(href);
    let dir = opf_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    normalize_path(if dir.is_empty() {
        href.to_string()
    } else {
        format!("{dir}/{href}")
    })
}

fn normalize_path(path: String) -> String {
    let mut output = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                output.pop();
            }
            value => output.push(value),
        }
    }
    output.join("/")
}

fn local_name(value: &[u8]) -> &[u8] {
    value.rsplit(|byte| *byte == b':').next().unwrap_or(value)
}

#[cfg(target_os = "windows")]
fn target_platform() -> &'static str {
    "windows"
}

#[cfg(target_os = "macos")]
fn target_platform() -> &'static str {
    "macos"
}

#[cfg(target_os = "ios")]
fn target_platform() -> &'static str {
    "ios"
}

#[cfg(target_os = "android")]
fn target_platform() -> &'static str {
    "android"
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "ios",
    target_os = "android"
)))]
fn target_platform() -> &'static str {
    "unknown"
}

fn parity_validated() -> bool {
    cfg!(target_os = "windows")
}

#[cfg(test)]
mod tests {
    use super::{normalize_path, resolve_relative};

    #[test]
    fn resolves_manifest_href_like_foliate() {
        assert_eq!(
            resolve_relative("OEBPS/content.opf", "nav/nav.xhtml#toc"),
            "OEBPS/nav/nav.xhtml"
        );
        assert_eq!(resolve_relative("content.opf", "../nav.xhtml"), "nav.xhtml");
    }

    #[test]
    fn normalizes_dot_segments() {
        assert_eq!(
            normalize_path("OEBPS/./text/../chapter.xhtml".to_string()),
            "OEBPS/chapter.xhtml"
        );
    }
}
