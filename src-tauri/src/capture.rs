//! `polakapi-capture` helper subcommand.
//!
//! Invoked by Claude / Codex hooks (which inherit the PTY env). Reads one
//! JSON event from stdin and writes it into `polakapi.db`. Open its own
//! connection in WAL mode — it does not talk to the running Tauri
//! backend.
//!
//! Two input schemas are accepted:
//! - Internal `CaptureEvent` JSON tagged by `kind` (used by tests and by
//!   hand-rolled integrators).
//! - Native Claude / Codex hook JSON tagged by `hook_event_name` (what
//!   Claude Code and Codex pass on stdin to every hook command). The
//!   helper translates the native shape into a `CaptureEvent` using env
//!   vars `POLAKAPI_PTY_ID` and `POLAKAPI_CLI` injected by `pty_spawn`.
//!
//! Required env vars:
//!   - `POLAKAPI_DB_PATH`: absolute path to `polakapi.db`.
//!
//! Fails soft: any error is logged to stderr and the process exits 0 so
//! the parent CLI hook never blocks on us.
//!
//! Diagnostics: every invocation appends one line to
//! `<POLAKAPI_DB_PATH>.log` (i.e. `polakapi.db.log` next to the DB) with
//! timestamp, CLI, event kind, pty_id, and a short payload preview. Tail
//! it during testing to confirm each CLI's hooks are firing:
//!   `tail -f ~/Library/Application\ Support/com.rafaelje.polakapi/polakapi.db.log`

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;

use crate::db::{apply_event, CaptureEvent, Db};

const LOG_ENV: &str = "POLAKAPI_LOG_PATH";

/// Entry point for `polakapi capture` — always returns 0 (best-effort,
/// never break the hook chain).
pub fn run() -> i32 {
    let started = std::time::SystemTime::now();
    match try_run() {
        Ok(event) => {
            log_line(&LogPayload::ok(&event, started));
            0
        }
        Err(msg) => {
            eprintln!("polakapi-capture: {msg}");
            log_line(&LogPayload::err(&msg, started));
            0
        }
    }
}

fn try_run() -> Result<CaptureEvent, String> {
    let db_path =
        std::env::var("POLAKAPI_DB_PATH").map_err(|_| "POLAKAPI_DB_PATH not set".to_string())?;
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("read stdin: {e}"))?;
    if buf.trim().is_empty() {
        return Err("empty stdin".into());
    }
    let v: serde_json::Value =
        serde_json::from_str(&buf).map_err(|e| format!("parse json: {e}"))?;
    let event = if v.get("kind").is_some() {
        serde_json::from_value::<CaptureEvent>(v).map_err(|e| format!("capture event: {e}"))?
    } else {
        translate_cli_hook(&v)?
    };
    // Policy: only persist user-authored prompts. The assistant's response
    // text is intentionally NOT stored — sees the user's written prompts as
    // a recall/history aid, not a transcript of what the model said. The
    // `Stop` / `AssistantStop` events still arrive (so the log shows the
    // CLI is healthy and the hook fired) but are dropped before any DB write.
    if matches!(event, CaptureEvent::AssistantStop { .. }) {
        return Ok(event);
    }
    let db = Db::open(std::path::Path::new(&db_path))?;
    apply_event(&db, &event)?;
    Ok(event)
}

/// Resolves the log path: `$POLAKAPI_LOG_PATH` if set, otherwise
/// `<POLAKAPI_DB_PATH>.log` (i.e. `polakapi.db.log`). Returns `None` when
/// neither `POLAKAPI_DB_PATH` nor `POLAKAPI_LOG_PATH` is set — in that
/// case logging is silently skipped (we never want to break the hook
/// chain just because the log dir is missing).
fn log_path() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var(LOG_ENV) {
        if !custom.is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    let db_path = std::env::var("POLAKAPI_DB_PATH").ok()?;
    Some(PathBuf::from(format!("{db_path}.log")))
}

fn log_line(payload: &LogPayload) {
    let Some(path) = log_path() else {
        return;
    };
    let line = payload.format();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

struct LogPayload {
    ts: String,
    cli: String,
    pty_id: String,
    kind: String,
    detail: String,
    ok: bool,
    elapsed_ms: u128,
}

impl LogPayload {
    fn ok(event: &CaptureEvent, started: std::time::SystemTime) -> Self {
        let elapsed_ms = started.elapsed().map(|d| d.as_millis()).unwrap_or(0);
        let (cli, pty_id, kind, detail) = describe(event);
        Self {
            ts: now_ts(),
            cli,
            pty_id,
            kind,
            detail,
            ok: true,
            elapsed_ms,
        }
    }

    fn err(msg: &str, started: std::time::SystemTime) -> Self {
        let elapsed_ms = started.elapsed().map(|d| d.as_millis()).unwrap_or(0);
        let cli = std::env::var("POLAKAPI_CLI").unwrap_or_else(|_| "?".into());
        let pty_id = std::env::var("POLAKAPI_PTY_ID").unwrap_or_else(|_| "?".into());
        Self {
            ts: now_ts(),
            cli,
            pty_id,
            kind: "error".into(),
            detail: msg.to_string(),
            ok: false,
            elapsed_ms,
        }
    }

    fn format(&self) -> String {
        let status = if self.ok { "OK" } else { "ERR" };
        format!(
            "{} [{}] cli={} pty={} event={} elapsed_ms={} {}",
            self.ts, status, self.cli, self.pty_id, self.kind, self.elapsed_ms, self.detail
        )
    }
}

fn describe(event: &CaptureEvent) -> (String, String, String, String) {
    match event {
        CaptureEvent::SessionStart {
            pty_id,
            cli,
            cli_session_id,
            cwd,
        } => {
            let detail = format!(
                "session_id={} cwd={}",
                cli_session_id.as_deref().unwrap_or(""),
                cwd.as_deref().unwrap_or("")
            );
            let env = env_cli();
            let cli = if env.is_empty() { cli.clone() } else { env };
            (cli, pty_id.clone(), "session-start".into(), detail)
        }
        CaptureEvent::UserPrompt { pty_id, user_input } => {
            let preview: String = user_input.chars().take(60).collect();
            (env_cli(), pty_id.clone(), "user-prompt".into(), preview)
        }
        CaptureEvent::AssistantStop {
            pty_id,
            response_text,
            ..
        } => {
            // Logged but not persisted — see `try_run` policy note.
            let len = response_text.as_deref().map(|s| s.len()).unwrap_or(0);
            (
                env_cli(),
                pty_id.clone(),
                "stop (dropped, not stored)".into(),
                format!("resp_len={len}"),
            )
        }
        CaptureEvent::SessionEnd { pty_id } => (
            env_cli(),
            pty_id.clone(),
            "session-end".into(),
            String::new(),
        ),
    }
}

/// `POLAKAPI_CLI` is the source of truth for which CLI fired the hook —
/// the env var is injected by `pty_spawn` and inherited by every hook
/// the CLI spawns, whereas the event payload only carries the field on
/// `SessionStart`.
fn env_cli() -> String {
    std::env::var("POLAKAPI_CLI").unwrap_or_default()
}

fn now_ts() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mon, da, h, mi, ss) = chrono_like(secs);
    format!("{y:04}-{mon:02}-{da:02} {h:02}:{mi:02}:{ss:02}")
}

/// Minimal UTC date breakdown without pulling chrono — the helper binary
/// stays small and we avoid adding another dependency just for log lines.
fn chrono_like(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let h = rem / 3600;
    let mi = (rem % 3600) / 60;
    let ss = rem % 60;
    // Civil-from-days (Howard Hinnant's algorithm). Returns (y, m, d)
    // proleptic Gregorian. Good enough for log timestamps; we don't care
    // about leap seconds or pre-1970 dates.
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let da = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let mon = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if mon <= 2 { y + 1 } else { y };
    (y as u64, mon, da, h, mi, ss)
}

/// Translates a native Claude / Codex hook JSON into a `CaptureEvent`.
/// Fields referenced come straight from each CLI's hook docs:
/// - `hook_event_name`: one of `SessionStart`, `UserPromptSubmit`, `Stop`,
///   `SessionEnd` (both CLIs use the same event names).
/// - `prompt`: present in `UserPromptSubmit` (both CLIs).
/// - `last_assistant_message`: present in `Stop` (both CLIs; may be null
///   in Codex).
/// - `session_id`: the CLI's own session id (we keep it as
///   `cli_session_id`).
/// - `cwd`: working directory.
/// - `reason`: present in `SessionEnd`.
///
/// `POLAKAPI_PTY_ID` is the bridge attribute to the polakapi terminal
/// tab. `POLAKAPI_CLI` disambiguates `claude` | `codex` | `opencode`.
fn translate_cli_hook(v: &serde_json::Value) -> Result<CaptureEvent, String> {
    let pty_id =
        std::env::var("POLAKAPI_PTY_ID").map_err(|_| "POLAKAPI_PTY_ID not set".to_string())?;
    let cli = std::env::var("POLAKAPI_CLI").unwrap_or_default();
    let event = v
        .get("hook_event_name")
        .and_then(|s| s.as_str())
        .ok_or_else(|| "missing hook_event_name".to_string())?;
    let cli_session_id = v
        .get("session_id")
        .and_then(|s| s.as_str())
        .map(String::from);
    let cwd = v.get("cwd").and_then(|s| s.as_str()).map(String::from);
    match event {
        "SessionStart" => Ok(CaptureEvent::SessionStart {
            pty_id,
            cli,
            cli_session_id,
            cwd,
        }),
        "UserPromptSubmit" => {
            let user_input = v
                .get("prompt")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            Ok(CaptureEvent::UserPrompt { pty_id, user_input })
        }
        "Stop" => {
            let response_text = v
                .get("last_assistant_message")
                .and_then(|s| s.as_str())
                .map(String::from);
            Ok(CaptureEvent::AssistantStop {
                pty_id,
                response_text,
                tokens_in: None,
                tokens_out: None,
                cost_usd: None,
                elapsed_ms: None,
                error: None,
            })
        }
        "SessionEnd" => Ok(CaptureEvent::SessionEnd { pty_id }),
        other => Err(format!("unsupported hook_event_name: {other}")),
    }
}
