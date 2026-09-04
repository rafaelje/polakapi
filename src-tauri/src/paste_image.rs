use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request};

/// Header the frontend sets on the raw-body invoke to tell us the image type.
const MIME_HEADER: &str = "x-image-mime";
/// Generous cap for a single pasted image; screenshots are a few MiB at most.
const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// Pasted images are scratch files: anything older than this is pruned on the
/// next paste so the temp dir does not grow forever.
const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
/// Fresh files are also bounded so a burst of large pastes cannot fill the
/// temp volume within the retention window; the oldest ones go first.
const MAX_FILES: usize = 50;
const MAX_DIR_BYTES: u64 = 512 * 1024 * 1024;

/// Images pasted into a terminal land here so their path can be handed to the
/// shell — agent CLIs (Claude Code, Codex, ...) read image files by path.
fn pasted_images_dir() -> PathBuf {
    std::env::temp_dir().join("polakapi").join("pasted-images")
}

pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    let essence = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match essence.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

pub fn save_image(dir: &Path, bytes: &[u8], extension: &str) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("pasted image is empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "pasted image too large: {} bytes (max {MAX_IMAGE_BYTES})",
            bytes.len()
        ));
    }
    create_private_dir(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    prune(
        dir,
        RETENTION,
        MAX_FILES.saturating_sub(1),
        MAX_DIR_BYTES.saturating_sub(bytes.len() as u64),
    );

    let dest = dir.join(unique_file_name(extension));
    write_private_file(&dest, bytes)
        .map_err(|e| format!("could not write {}: {e}", dest.display()))?;
    Ok(dest)
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

fn write_private_file(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(dest)?;
    file.write_all(bytes)?;
    file.flush()
}

fn unique_file_name(extension: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    format!("paste-{millis}-{}.{extension}", &suffix[..8])
}

/// Removes files older than `retention`, then the oldest of the rest until at
/// most `keep_files` files and `keep_bytes` bytes remain.
fn prune(dir: &Path, retention: Duration, keep_files: usize, keep_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    let mut fresh: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
        if age > retention {
            let _ = std::fs::remove_file(entry.path());
        } else {
            fresh.push((modified, metadata.len(), entry.path()));
        }
    }
    fresh.sort_by(|a, b| b.0.cmp(&a.0));
    let mut kept_files = 0usize;
    let mut kept_bytes = 0u64;
    for (_, len, path) in fresh {
        let within_quota = kept_files < keep_files && kept_bytes.saturating_add(len) <= keep_bytes;
        if within_quota {
            kept_files += 1;
            kept_bytes += len;
        } else {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tauri::command]
pub fn save_pasted_image(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_pasted_image expects a raw binary body".to_string());
    };
    let mime = request
        .headers()
        .get(MIME_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let extension =
        extension_for_mime(mime).ok_or_else(|| format!("unsupported image type: {mime:?}"))?;
    let path = save_image(&pasted_images_dir(), bytes, extension)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_image_mimes_and_ignores_parameters() {
        assert_eq!(extension_for_mime("image/png"), Some("png"));
        assert_eq!(
            extension_for_mime("IMAGE/JPEG; charset=binary"),
            Some("jpg")
        );
        assert_eq!(extension_for_mime("image/webp"), Some("webp"));
        assert_eq!(extension_for_mime("text/plain"), None);
        assert_eq!(extension_for_mime(""), None);
    }

    #[test]
    fn writes_bytes_under_a_unique_name() {
        let tmp = tempfile::tempdir().unwrap();
        let first = save_image(tmp.path(), b"png-bytes", "png").unwrap();
        let second = save_image(tmp.path(), b"other", "png").unwrap();

        assert_ne!(first, second);
        assert_eq!(first.extension().and_then(|e| e.to_str()), Some("png"));
        assert_eq!(std::fs::read(&first).unwrap(), b"png-bytes");
        assert_eq!(std::fs::read(&second).unwrap(), b"other");
    }

    #[test]
    fn rejects_empty_payloads() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(save_image(tmp.path(), b"", "png").is_err());
    }

    #[test]
    fn prunes_files_older_than_retention() {
        let tmp = tempfile::tempdir().unwrap();
        let stale = tmp.path().join("stale.png");
        std::fs::write(&stale, b"x").unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();

        prune(tmp.path(), Duration::from_secs(1), usize::MAX, u64::MAX);
        assert!(!stale.exists());
    }

    #[test]
    fn prunes_oldest_fresh_files_beyond_the_quota() {
        let tmp = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for index in 0..4 {
            let path = tmp.path().join(format!("paste-{index}.png"));
            std::fs::write(&path, [0u8; 10]).unwrap();
            let modified = SystemTime::now() - Duration::from_secs(100 - index);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(modified)
                .unwrap();
            paths.push(path);
        }

        prune(tmp.path(), RETENTION, 3, 25);

        assert!(!paths[0].exists(), "oldest file exceeds both quotas");
        assert!(!paths[1].exists(), "second oldest exceeds the byte quota");
        assert!(paths[2].exists());
        assert!(paths[3].exists());
    }

    #[cfg(unix)]
    #[test]
    fn creates_owner_only_dir_and_files() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("pasted-images");
        let file = save_image(&dir, b"png", "png").unwrap();

        let dir_mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        let file_mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        assert_eq!(file_mode, 0o600);
    }
}
