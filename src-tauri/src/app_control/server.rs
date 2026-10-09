use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

// Loopback control channel for the operator agent. `polakapi app-mcp` runs as
// a child of the CLI, outside the Tauri process, so every tool call it
// receives travels here: one JSON line in, one JSON line out. The request is
// relayed to the main webview, which owns the workspaces state, and the
// webview answers through the `app_control_respond` command.
//
// A per-launch token guards the port. The token is stored next to the app's
// other data, readable only by the user, and never sent over the wire by the
// app itself.
//
// The file is named after the instance's pid: a second instance (a dev build
// next to the installed one, or an accidental relaunch) must not hijack the
// MCP servers of the first. Each agent launch registers the file of the
// instance that launched it, and stale files of dead instances are swept at
// startup.

const CONTROL_FILE_PREFIX: &str = "agent-control-";
const CONTROL_FILE_SUFFIX: &str = ".json";
pub const REQUEST_EVENT: &str = "app-control:request";
const MAIN_WINDOW: &str = "main";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct Reply {
    pub ok: bool,
    pub payload: Value,
}

pub struct ControlServer {
    port: u16,
    token: String,
    file: PathBuf,
    ready: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<Reply>>>,
}

impl ControlServer {
    pub fn control_file(&self) -> &Path {
        &self.file
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Called when the main window goes away, so a later MCP call reports the
    /// instance as gone instead of timing out on a dead port.
    pub fn remove_control_file(&self) {
        let _ = std::fs::remove_file(&self.file);
    }

    /// The webview flips this when its bridge mounts and unmounts, so callers
    /// get an immediate refusal instead of a long timeout while it is gone.
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }

    pub fn resolve(&self, id: u64, reply: Reply) -> bool {
        let sender = self.pending.lock().expect("pending poisoned").remove(&id);
        match sender {
            Some(sender) => sender.send(reply).is_ok(),
            None => false,
        }
    }

    /// Relays one request to the main webview and blocks until it answers.
    /// Used by the TCP listener and, in-process, by the Telegram bot.
    pub fn relay(&self, app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
        if !self.ready.load(Ordering::SeqCst) {
            return Err("polakapi's main window is not ready to take requests".to_string());
        }
        let (id, receiver) = self.register();
        let emitted = app.emit_to(
            MAIN_WINDOW,
            REQUEST_EVENT,
            json!({ "id": id, "method": method, "params": params }),
        );
        if emitted.is_err() {
            self.forget(id);
            return Err("could not reach polakapi's main window".to_string());
        }
        match receiver.recv_timeout(RESPONSE_TIMEOUT) {
            Ok(Reply { ok: true, payload }) => Ok(payload),
            Ok(Reply { ok: false, payload }) => Err(payload
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| payload.to_string())),
            Err(_) => {
                self.forget(id);
                Err("polakapi did not answer in time".to_string())
            }
        }
    }

    fn register(&self) -> (u64, Receiver<Reply>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .expect("pending poisoned")
            .insert(id, tx);
        (id, rx)
    }

    fn forget(&self, id: u64) {
        self.pending.lock().expect("pending poisoned").remove(&id);
    }
}

fn control_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn control_file_name(pid: u32) -> String {
    format!("{CONTROL_FILE_PREFIX}{pid}{CONTROL_FILE_SUFFIX}")
}

fn pid_from_file_name(name: &str) -> Option<u32> {
    name.strip_prefix(CONTROL_FILE_PREFIX)?
        .strip_suffix(CONTROL_FILE_SUFFIX)?
        .parse()
        .ok()
}

fn is_alive(pid: u32) -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
    );
    system.process(sysinfo::Pid::from_u32(pid)).is_some()
}

/// Removes control files left behind by instances that are no longer running.
/// The old single-name file from earlier builds is removed too.
pub fn sweep_stale(dir: &Path, own_pid: u32) {
    let _ = std::fs::remove_file(dir.join("agent-control.json"));
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(pid_from_file_name) else {
            continue;
        };
        if pid != own_pid && !is_alive(pid) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Binds a loopback port, writes the control file and starts the accept loop.
pub fn start(app: &AppHandle) -> Result<Arc<ControlServer>, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bind control port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("control port address: {e}"))?
        .port();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let dir = control_dir(app)?;
    let pid = std::process::id();
    sweep_stale(&dir, pid);
    let file = dir.join(control_file_name(pid));
    write_control_file(&file, port, &token)?;

    let server = Arc::new(ControlServer {
        port,
        token,
        file,
        ready: AtomicBool::new(false),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
    });

    let accept_server = server.clone();
    let accept_app = app.clone();
    std::thread::Builder::new()
        .name("polakapi-control".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let server = accept_server.clone();
                let app = accept_app.clone();
                let _ = std::thread::Builder::new()
                    .name("polakapi-control-conn".into())
                    .spawn(move || serve_connection(stream, &server, &app));
            }
        })
        .map_err(|e| format!("spawn control thread: {e}"))?;
    Ok(server)
}

fn write_control_file(path: &Path, port: u16, token: &str) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let body = serde_json::to_string_pretty(&json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "exe": exe,
    }))
    .map_err(|e| format!("serialize control file: {e}"))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    file.write_all(body.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))
}

fn serve_connection(stream: TcpStream, server: &ControlServer, app: &AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(300)));
    let mut writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(n) if n > MAX_LINE_BYTES => {
                let _ = writeln!(writer, "{}", error_line("request too large"));
                return;
            }
            Ok(_) => {}
        }
        let response = handle_line(&line, server, app);
        if writeln!(writer, "{response}").is_err() || writer.flush().is_err() {
            return;
        }
    }
}

fn error_line(message: &str) -> Value {
    json!({ "ok": false, "error": message })
}

fn handle_line(line: &str, server: &ControlServer, app: &AppHandle) -> Value {
    let request: Value = match serde_json::from_str(line.trim()) {
        Ok(value) => value,
        Err(_) => return error_line("malformed request"),
    };
    let token = request.get("token").and_then(Value::as_str).unwrap_or("");
    if !constant_time_eq(token, &server.token) {
        return error_line("invalid control token");
    }
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return error_line("missing method");
    };
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let answer = super::telegram::actions::intercept(server, app, method, &params)
        .unwrap_or_else(|| server.relay(app, method, params));
    match answer {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(message) => error_line(&message),
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_rejects_mismatches() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }

    #[test]
    fn control_file_is_private_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(control_file_name(4242));
        write_control_file(&path, 4321, "tok").unwrap();
        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["port"], 4321);
        assert_eq!(parsed["token"], "tok");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn sweep_removes_dead_instances_and_keeps_live_ones() {
        let dir = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let dead = dir.path().join(control_file_name(u32::MAX - 7));
        let live = dir.path().join(control_file_name(own));
        let legacy = dir.path().join("agent-control.json");
        let other = dir.path().join("notes.json");
        for path in [&dead, &live, &legacy, &other] {
            std::fs::write(path, "{}").unwrap();
        }
        sweep_stale(dir.path(), own);
        assert!(!dead.exists());
        assert!(!legacy.exists());
        assert!(live.exists());
        assert!(other.exists());
        assert_eq!(pid_from_file_name("agent-control-12.json"), Some(12));
        assert_eq!(pid_from_file_name("agent-control.json"), None);
    }
}
