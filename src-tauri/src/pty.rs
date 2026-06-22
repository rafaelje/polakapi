use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "windows")]
const ALLOWED_SHELL_BASENAMES: &[&str] = &[
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
];

#[cfg(not(target_os = "windows"))]
const ALLOWED_SHELL_BASENAMES: &[&str] =
    &["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh"];

const MAX_ARG_LEN: usize = 4096;
const MAX_ARGS: usize = 64;
const MAX_CWD_LEN: usize = 4096;

pub struct PtySession {
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub child: Mutex<Box<dyn Child + Send + Sync>>,
}

#[derive(Default)]
pub struct PtyStore {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtyStore {
    pub fn session(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().get(id).cloned()
    }

    pub fn insert_session(&self, id: String, session: Arc<PtySession>) {
        self.sessions.lock().insert(id, session);
    }

    pub fn remove_session(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().remove(id)
    }

    pub fn kill_session(&self, id: &str) {
        if let Some(session) = self.remove_session(id) {
            let _ = session.child.lock().kill();
        }
    }

    pub fn kill_all(&self) {
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in sessions {
            let _ = session.child.lock().kill();
        }
    }
}

impl Drop for PtyStore {
    fn drop(&mut self) {
        self.kill_all();
    }
}

#[derive(Clone, Serialize)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct PtyExitPayload {
    pub id: String,
}

pub fn spawn_session(
    app: AppHandle,
    store: Arc<PtyStore>,
    cols: u16,
    rows: u16,
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = resolve_shell(command)?;
    let validated_args = validate_args(args)?;
    let validated_cwd = validate_cwd(cwd)?;

    let mut cmd = CommandBuilder::new(shell);
    for arg in validated_args {
        cmd.arg(arg);
    }
    if let Some(dir) = validated_cwd {
        cmd.cwd(dir);
    } else if let Some(dir) = default_working_dir() {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();

    let session = Arc::new(PtySession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
    });
    store.insert_session(id.clone(), session);

    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    let store_for_thread = store.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::with_capacity(64);
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let chunk = drain_valid_utf8(&mut pending);
                    if !chunk.is_empty() {
                        let _ = app_for_thread.emit(
                            "pty:data",
                            PtyDataPayload {
                                id: id_for_thread.clone(),
                                data: chunk,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let chunk = String::from_utf8_lossy(&pending).to_string();
            let _ = app_for_thread.emit(
                "pty:data",
                PtyDataPayload {
                    id: id_for_thread.clone(),
                    data: chunk,
                },
            );
        }
        let _ = app_for_thread.emit(
            "pty:exit",
            PtyExitPayload {
                id: id_for_thread.clone(),
            },
        );
        store_for_thread.remove_session(&id_for_thread);
    });

    Ok(id)
}

fn resolve_shell(command: Option<String>) -> Result<String, String> {
    let requested = command
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    match requested {
        Some(cmd) => {
            if !is_allowed_shell(&cmd) {
                return Err(format!("shell not allowed: {cmd}"));
            }
            Ok(cmd)
        }
        None => Ok(default_shell()),
    }
}

fn is_allowed_shell(cmd: &str) -> bool {
    if cmd.contains('\0') {
        return false;
    }
    let basename = Path::new(cmd)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(cmd);
    let normalized = basename.to_ascii_lowercase();
    ALLOWED_SHELL_BASENAMES
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(&normalized))
}

fn validate_args(args: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let Some(items) = args else {
        return Ok(Vec::new());
    };
    if items.len() > MAX_ARGS {
        return Err(format!("too many args (max {MAX_ARGS})"));
    }
    for arg in &items {
        if arg.len() > MAX_ARG_LEN {
            return Err(format!("arg too long (max {MAX_ARG_LEN} bytes)"));
        }
        if arg.contains('\0') {
            return Err("arg contains NUL byte".to_string());
        }
    }
    Ok(items)
}

fn validate_cwd(cwd: Option<String>) -> Result<Option<String>, String> {
    let Some(dir) = cwd else { return Ok(None) };
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_CWD_LEN {
        return Err(format!("cwd too long (max {MAX_CWD_LEN} bytes)"));
    }
    if trimmed.contains('\0') {
        return Err("cwd contains NUL byte".to_string());
    }
    Ok(Some(trimmed.to_string()))
}

fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| is_allowed_shell(s))
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

fn default_working_dir() -> Option<PathBuf> {
    home_dir_from_env().or_else(|| std::env::current_dir().ok())
}

fn home_dir_from_env() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        return Some(PathBuf::from(home));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return Some(PathBuf::from(profile));
    }
    match (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
        (Some(drive), Some(path)) => Some(PathBuf::from(format!(
            "{}{}",
            drive.to_string_lossy(),
            path.to_string_lossy()
        ))),
        _ => None,
    }
}

/// Drains the longest valid UTF-8 prefix from `buf` and returns it as a String.
/// Any trailing partial code-point bytes remain in `buf` for the next chunk.
fn drain_valid_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let out = s.to_owned();
            buf.clear();
            out
        }
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            if valid_up_to == 0 {
                // Either the partial codepoint sits at index 0 with more bytes expected,
                // or we have an actually-invalid byte. If the partial fits a multi-byte
                // start, wait for more bytes; otherwise drop one byte as replacement.
                if let Some(first) = buf.first().copied() {
                    let needed = utf8_first_byte_width(first);
                    if needed > 0 && buf.len() < needed {
                        return String::new();
                    }
                }
                let bad = buf.remove(0);
                return char::REPLACEMENT_CHARACTER.to_string()
                    + &drain_valid_utf8_after_bad(buf, bad);
            }
            let out = std::str::from_utf8(&buf[..valid_up_to])
                .expect("validated")
                .to_owned();
            buf.drain(..valid_up_to);
            out
        }
    }
}

fn drain_valid_utf8_after_bad(buf: &mut Vec<u8>, _bad: u8) -> String {
    // After dropping one byte, retry the drain — recursive call is bounded by buf length.
    drain_valid_utf8(buf)
}

fn utf8_first_byte_width(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b & 0xE0 == 0xC0 {
        2
    } else if b & 0xF0 == 0xE0 {
        3
    } else if b & 0xF8 == 0xF0 {
        4
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_pure_ascii() {
        let mut buf = b"hello".to_vec();
        let out = drain_valid_utf8(&mut buf);
        assert_eq!(out, "hello");
        assert!(buf.is_empty());
    }

    #[test]
    fn holds_back_partial_multibyte() {
        // "é" in UTF-8 is 0xC3 0xA9
        let mut buf = vec![0xC3];
        let out = drain_valid_utf8(&mut buf);
        assert_eq!(out, "");
        assert_eq!(buf, vec![0xC3]);
        buf.push(0xA9);
        let out = drain_valid_utf8(&mut buf);
        assert_eq!(out, "é");
        assert!(buf.is_empty());
    }

    #[test]
    fn handles_partial_at_end_of_stream() {
        // "hello" then partial "é"
        let mut buf = vec![b'h', b'i', 0xC3];
        let out = drain_valid_utf8(&mut buf);
        assert_eq!(out, "hi");
        assert_eq!(buf, vec![0xC3]);
    }

    #[test]
    fn allowed_shell_accepts_basename_and_path() {
        #[cfg(not(target_os = "windows"))]
        {
            assert!(is_allowed_shell("bash"));
            assert!(is_allowed_shell("/bin/bash"));
            assert!(is_allowed_shell("/usr/local/bin/zsh"));
        }
        #[cfg(target_os = "windows")]
        {
            assert!(is_allowed_shell("cmd.exe"));
            assert!(is_allowed_shell("C:\\Windows\\System32\\cmd.exe"));
        }
    }

    #[test]
    fn allowed_shell_rejects_arbitrary_binary() {
        assert!(!is_allowed_shell("/usr/bin/curl"));
        assert!(!is_allowed_shell("rm"));
        assert!(!is_allowed_shell(""));
        assert!(!is_allowed_shell("bash\0evil"));
    }

    #[test]
    fn resolve_shell_rejects_disallowed() {
        let err = resolve_shell(Some("curl".to_string())).unwrap_err();
        assert!(err.contains("not allowed"));
    }

    #[test]
    fn resolve_shell_uses_default_when_empty() {
        let resolved = resolve_shell(Some("   ".to_string())).unwrap();
        assert!(!resolved.is_empty());
    }

    #[test]
    fn validate_args_enforces_caps() {
        assert!(validate_args(None).unwrap().is_empty());
        let many = (0..(MAX_ARGS + 1)).map(|_| "x".to_string()).collect();
        assert!(validate_args(Some(many)).is_err());
        let huge = "a".repeat(MAX_ARG_LEN + 1);
        assert!(validate_args(Some(vec![huge])).is_err());
        assert!(validate_args(Some(vec!["ok\0bad".to_string()])).is_err());
    }

    #[test]
    fn validate_cwd_trims_and_caps() {
        assert!(validate_cwd(None).unwrap().is_none());
        assert!(validate_cwd(Some("   ".to_string())).unwrap().is_none());
        assert_eq!(
            validate_cwd(Some("  /tmp  ".to_string()))
                .unwrap()
                .as_deref(),
            Some("/tmp")
        );
        let huge = "a".repeat(MAX_CWD_LEN + 1);
        assert!(validate_cwd(Some(huge)).is_err());
    }
}
