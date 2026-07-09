use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use crate::fs::validate_path;

/// Tracks live external terminal windows (Ghostty) keyed by canonical project
/// path. Prevents a second click from spawning a duplicate window for the same
/// project. Entries whose child has exited are lazily reaped on the next
/// `spawn_or_focus` call for that path.
#[derive(Default)]
pub struct ShellRegistry {
    inner: Mutex<HashMap<PathBuf, Child>>,
}

impl ShellRegistry {
    /// Spawns a Ghostty window at `path` unless one is already open for that
    /// path. Returns `Ok(())` in both cases — the caller cannot distinguish
    /// "opened" from "already open" and doesn't need to.
    pub fn spawn_or_focus(&self, path: &str) -> Result<(), String> {
        let canonical = PathBuf::from(path);
        let mut map = self.inner.lock().map_err(|e| e.to_string())?;

        // Reap any dead entry for this path before deciding.
        if let Some(child) = map.get_mut(&canonical) {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) | Err(_) => {
                    map.remove(&canonical);
                }
            }
        }

        #[cfg(unix)]
        {
            let child = Command::new("ghostty")
                .arg(format!("--working-directory={path}"))
                .spawn()
                .map_err(|e| format!("failed to launch ghostty: {e}"))?;
            map.insert(canonical, child);
        }
        #[cfg(windows)]
        {
            let _ = path;
            return Err("ghostty is not available on Windows".to_string());
        }
        Ok(())
    }
}

/// Closed set of editor binaries the frontend is allowed to invoke. The
/// WebView cannot pass arbitrary commands — only these basenames are accepted.
/// Add new entries here when supporting another IDE.
const ALLOWED_EDITORS: &[&str] = &[
    "agy-ide", "code", "cursor", "subl", "idea", "zeditor", "vim", "emacs", "atom", "nova",
];

/// Fallback probe order when no explicit editor is requested. The first binary
/// found on PATH wins.
const FALLBACK_ORDER: &[&str] = &["agy-ide", "code"];

/// Returns `true` when `editor` is in the allowlist.
fn is_allowed(editor: &str) -> bool {
    ALLOWED_EDITORS.contains(&editor)
}

/// Probes whether `cmd` is reachable on PATH. Uses `which` on Unix and `where`
/// on Windows. Never panics.
fn command_exists(cmd: &str) -> bool {
    #[cfg(unix)]
    let probe = "which";
    #[cfg(windows)]
    let probe = "where";

    Command::new(probe)
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Resolves the editor to invoke:
///
/// 1. If `explicit` is given and allowed, use it.
/// 2. Otherwise probe [`FALLBACK_ORDER`] and return the first hit.
///
/// Returns `None` when nothing is available.
fn resolve_editor(explicit: Option<&str>) -> Option<String> {
    if let Some(cmd) = explicit {
        if is_allowed(cmd) {
            return Some(cmd.to_string());
        }
        return None;
    }
    for &cmd in FALLBACK_ORDER {
        if command_exists(cmd) {
            return Some(cmd.to_string());
        }
    }
    None
}

/// Opens `path` in the OS file manager (Finder, Explorer, xdg-open). The path
/// is validated through [`validate_path`] so unreadable or non-directory paths
/// are rejected before spawning any process.
pub fn open_in_explorer(path: &str) -> Result<(), String> {
    validate_path(path).map_err(|err| err.as_contract_string())?;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Opens `path` in an editor. When `editor` is `None`, the first available
/// binary from [`FALLBACK_ORDER`] is used. The path is validated through
/// [`validate_path`] and the editor is launched with the directory as its sole
/// argument, spawned detached so the app never blocks.
pub fn open_in_editor(path: &str, editor: Option<&str>) -> Result<(), String> {
    validate_path(path).map_err(|err| err.as_contract_string())?;

    let cmd = resolve_editor(editor)
        .ok_or_else(|| "no editor found on PATH (tried agy-ide, code)".to_string())?;

    Command::new(&cmd)
        .arg(path)
        .spawn()
        .map_err(|e| format!("failed to launch {cmd}: {e}"))?;
    Ok(())
}

/// Launches an external Ghostty terminal window at `path` as the working
/// directory. If a window is already open for that path it is reused (no-op).
/// Returns an error on Windows where Ghostty is unavailable.
pub fn open_in_shell(registry: &ShellRegistry, path: &str) -> Result<(), String> {
    validate_path(path).map_err(|err| err.as_contract_string())?;
    registry.spawn_or_focus(path)
}

/// Opens a single file `path` in an editor. Same resolver/allowlist as
/// [`open_in_editor`], but accepts files (not directories). Used by `/loop`
/// step 1 to open `<run>/prompts/problem-intake.md` for editing.
pub fn open_file_in_editor(path: &str, editor: Option<&str>) -> Result<(), String> {
    let p = std::path::Path::new(path);
    let metadata = std::fs::metadata(p).map_err(|e| format!("invalid path: {e}"))?;
    if metadata.is_dir() {
        return Err("path is a directory, use open_in_editor".to_string());
    }

    let cmd = resolve_editor(editor)
        .ok_or_else(|| "no editor found on PATH (tried agy-ide, code)".to_string())?;

    Command::new(&cmd)
        .arg(path)
        .spawn()
        .map_err(|e| format!("failed to launch {cmd}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_known_editors() {
        assert!(is_allowed("agy-ide"));
        assert!(is_allowed("code"));
        assert!(is_allowed("cursor"));
    }

    #[test]
    fn allowlist_rejects_unknown_binary() {
        assert!(!is_allowed("rm"));
        assert!(!is_allowed(""));
        assert!(!is_allowed("/usr/bin/code"));
    }

    #[test]
    fn resolve_explicit_uses_allowlist() {
        assert_eq!(resolve_editor(Some("code")).as_deref(), Some("code"));
        assert_eq!(resolve_editor(Some("agy-ide")).as_deref(), Some("agy-ide"));
        // Rejected — not in allowlist.
        assert_eq!(resolve_editor(Some("rm")), None);
    }

    #[test]
    fn open_in_editor_rejects_non_directory() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let file = format!("{manifest}/Cargo.toml");
        let result = open_in_editor(&file, Some("code"));
        assert!(result.is_err());
    }

    #[test]
    fn open_in_shell_rejects_nonexistent_path() {
        let registry = ShellRegistry::default();
        let result = open_in_shell(&registry, "/nonexistent/does-not-exist-12345");
        assert!(result.is_err());
    }
}
