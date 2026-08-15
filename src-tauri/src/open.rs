use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use crate::fs::validate_path;
use crate::platform_command::{self, ResolvedProgram};

/// Tracks live external terminal windows keyed by canonical project
/// path. Prevents a second click from spawning a duplicate window for the same
/// project. Entries whose child has exited are lazily reaped on the next
/// `spawn_or_focus` call for that path.
#[derive(Default)]
pub struct ShellRegistry {
    inner: Mutex<HashMap<PathBuf, Child>>,
}

impl ShellRegistry {
    /// Spawns a terminal window at `path` unless one is already open for that
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

        let child = shell_command(path)?
            .spawn()
            .map_err(|e| format!("failed to launch terminal: {e}"))?;
        map.insert(canonical, child);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn shell_command(path: &str) -> Result<Command, String> {
    let mut command = Command::new("open");
    command
        .args(["-na", "Ghostty.app", "--args"])
        .arg(format!("--working-directory={path}"));
    Ok(command)
}

#[cfg(target_os = "linux")]
fn shell_command(path: &str) -> Result<Command, String> {
    let mut command = Command::new("ghostty");
    command.arg(format!("--working-directory={path}"));
    Ok(command)
}

#[cfg(target_os = "windows")]
fn shell_command(path: &str) -> Result<Command, String> {
    if let Ok(program) = platform_command::resolve_program("wt") {
        let mut command = Command::new(program.path());
        command.args(["-d", path]);
        return Ok(command);
    }

    for shell in ["pwsh", "powershell"] {
        if let Ok(program) = platform_command::resolve_program(shell) {
            return Ok(windows_console_command(
                program.path(),
                &["-NoLogo", "-NoExit"],
                path,
            ));
        }
    }

    let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
    Ok(windows_console_command(
        std::path::Path::new(&comspec),
        &["/D"],
        path,
    ))
}

#[cfg(target_os = "windows")]
fn windows_console_command(program: &std::path::Path, args: &[&str], path: &str) -> Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(path)
        .creation_flags(CREATE_NEW_CONSOLE);
    command
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

/// Probes whether `cmd` is reachable on PATH. Never panics.
fn command_exists(cmd: &str) -> bool {
    #[cfg(unix)]
    {
        Command::new("which")
            .arg(cmd)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        platform_command::resolve_program(cmd).is_ok()
    }
}

/// Resolves the editor to invoke:
///
/// 1. If `explicit` is given and allowed, use it.
/// 2. Otherwise probe [`FALLBACK_ORDER`] and return the first hit.
///
/// Returns `None` when nothing is available.
fn resolve_editor(explicit: Option<&str>) -> Option<ResolvedProgram> {
    if let Some(cmd) = explicit {
        if is_allowed(cmd) {
            return platform_command::resolve_program(cmd).ok();
        }
        return None;
    }
    for &cmd in FALLBACK_ORDER {
        if command_exists(cmd) {
            return platform_command::resolve_program(cmd).ok();
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

    Command::new(cmd.path())
        .arg(path)
        .spawn()
        .map_err(|e| format!("failed to launch {}: {e}", cmd.display_name()))?;
    Ok(())
}

/// Launches an external terminal window at `path` as the working
/// directory. If a window is already open for that path it is reused (no-op).
pub fn open_in_shell(registry: &ShellRegistry, path: &str) -> Result<(), String> {
    validate_path(path).map_err(|err| err.as_contract_string())?;
    registry.spawn_or_focus(path)
}

/// Opens an http(s) URL in the system browser. Only web schemes are accepted —
/// file://, javascript: etc. are rejected so terminal output cannot make the
/// host open arbitrary targets.
pub fn open_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if !is_web_url(trimmed) {
        return Err(format!("url scheme not allowed: {trimmed}"));
    }

    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");

    command
        .arg(trimmed)
        .spawn()
        .map_err(|e| format!("failed to open url: {e}"))?;
    Ok(())
}

fn is_web_url(url: &str) -> bool {
    if url.contains('\0') {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Opens a local path clicked in a terminal: directories in the file manager,
/// files in the editor (falling back to revealing the parent directory when no
/// editor is on PATH). A leading `~` is expanded against $HOME.
pub fn open_local_path(path: &str) -> Result<(), String> {
    let expanded = expand_home(path.trim());
    let metadata = std::fs::metadata(&expanded).map_err(|e| format!("invalid path: {e}"))?;
    if metadata.is_dir() {
        return open_in_explorer(&expanded);
    }
    open_file_in_editor(&expanded, None).or_else(|_| {
        let parent = std::path::Path::new(&expanded)
            .parent()
            .ok_or_else(|| "path has no parent directory".to_string())?;
        open_in_explorer(&parent.to_string_lossy())
    })
}

fn expand_home(path: &str) -> String {
    let home = platform_command::user_home_dir().map(|path| path.to_string_lossy().into_owned());
    expand_home_with(path, home.as_deref())
}

fn expand_home_with(path: &str, home: Option<&str>) -> String {
    if path == "~" {
        return home.unwrap_or(path).to_string();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(dir) = home {
            return format!("{dir}/{rest}");
        }
    }
    if let Some(rest) = path.strip_prefix("~\\") {
        if let Some(dir) = home {
            return format!("{dir}\\{rest}");
        }
    }
    path.to_string()
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

    Command::new(cmd.path())
        .arg(path)
        .spawn()
        .map_err(|e| format!("failed to launch {}: {e}", cmd.display_name()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_web_url_accepts_only_http_and_https() {
        assert!(is_web_url("https://example.com/a?b=c"));
        assert!(is_web_url("http://localhost:5173"));
        assert!(is_web_url("HTTPS://EXAMPLE.COM"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("ftp://host"));
        assert!(!is_web_url("/home/user/file"));
        assert!(!is_web_url("https://x\0y"));
    }

    #[test]
    fn open_url_rejects_non_web_schemes() {
        assert!(open_url("file:///etc/passwd").is_err());
        assert!(open_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn expand_home_handles_tilde_prefix() {
        let home = Some("/home/tester");
        assert_eq!(expand_home_with("~", home), "/home/tester");
        assert_eq!(
            expand_home_with("~/repo/file.rs", home),
            "/home/tester/repo/file.rs"
        );
        assert_eq!(
            expand_home_with("~\\repo\\file.rs", Some(r"C:\Users\tester")),
            r"C:\Users\tester\repo\file.rs"
        );
        assert_eq!(expand_home_with("/absolute/path", home), "/absolute/path");
        assert_eq!(expand_home_with("~other/x", home), "~other/x");
        assert_eq!(expand_home_with("~", None), "~");
    }

    #[test]
    fn open_local_path_rejects_nonexistent() {
        assert!(open_local_path("/nonexistent/does-not-exist-9876").is_err());
    }

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

    #[cfg(target_os = "macos")]
    #[test]
    fn shell_command_uses_macos_app_launcher() {
        let command = shell_command("/tmp/project").unwrap();
        assert_eq!(command.get_program(), "open");
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            [
                "-na",
                "Ghostty.app",
                "--args",
                "--working-directory=/tmp/project"
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn console_fallback_starts_in_the_requested_directory() {
        let command = windows_console_command(
            std::path::Path::new(r"C:\Windows\System32\cmd.exe"),
            &["/D"],
            r"C:\code\polakapi",
        );
        assert_eq!(
            command.get_current_dir(),
            Some(std::path::Path::new(r"C:\code\polakapi"))
        );
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["/D"]);
    }
}
