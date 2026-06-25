//! Subprocess wrapper for the LLM CLIs used by the `/loop` window.
//!
//! Exposes a single Tauri command `run_loop_agent` that normalizes the one-shot
//! invocation of `claude`, `codex` and `opencode` into a common
//! [`AgentResult`]. The decision to keep this in a separate module (instead of
//! extending `commands.rs`) mirrors the layer separation the repo already
//! uses: the `pty.rs` module isolates the `portable_pty` wrapping, and this
//! module does the analogous thing for the one-shot pattern with
//! `std::process::Command::output()`.
//!
//! Key technical design:
//! - `tokio::time::timeout` wraps the blocking execution via
//!   `tokio::task::spawn_blocking`. The default is 300s (aligned with the
//!   design doc, "Risks" section, hung subprocess row).
//! - Output parsing is CLI-specific (each CLI has a different format) and
//!   lives in separate `parse_*` functions so they can be tested in isolation
//!   in the future.
//! - Errors are returned as `AgentResult { error: Some(...) }` instead of
//!   `Err(...)` when dealing with expected CLI failures (exit != 0, malformed
//!   JSON). We reserve `Err(...)` for wrapper failures (timeout, CLI not
//!   found, fatal IO). This gives the frontend a uniform channel for
//!   surfacing warnings without having to distinguish exceptions from status
//!   fields.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::timeout;

/// Default timeout in seconds for an agent invocation. Aligned with the
/// design doc (300s). Configurable via command argument.
const DEFAULT_TIMEOUT_SECS: u64 = 300;

/// Normalized output of any LLM CLI invoked by the `/loop` module.
///
/// The fields `tokens_in`, `tokens_out`, `cost_usd` and `session_id` are
/// optional because not every CLI exposes them in one-shot mode (e.g.
/// `opencode` does not report cost). `text` is always populated when possible
/// — if there is nothing, it stays as an empty string and `error` should be
/// set.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResult {
    /// The last message from the agent (the "result" of the one-shot run).
    pub text: String,
    /// Input tokens reported by the CLI, if available.
    pub tokens_in: Option<u64>,
    /// Output tokens reported by the CLI, if available.
    pub tokens_out: Option<u64>,
    /// Cost in USD reported by the CLI, if available.
    pub cost_usd: Option<f64>,
    /// CLI session id (useful only for debugging — we do not use persistent
    /// sessions, see design decision #3).
    pub session_id: Option<String>,
    /// Human-readable error message if the invocation returned exit != 0 or
    /// the output could not be parsed. `None` indicates clean success.
    pub error: Option<String>,
}

impl AgentResult {
    fn empty_with_error(message: impl Into<String>) -> Self {
        Self {
            text: String::new(),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
            session_id: None,
            error: Some(message.into()),
        }
    }
}

/// Tauri command that invokes the configured CLI in one-shot mode and returns
/// a normalized [`AgentResult`].
///
/// `cli` is one of `"claude" | "codex" | "opencode"`. Other values return
/// `Err(...)` immediately.
///
/// `system_prompt_path` and `user_input` are passed to the CLI as flags/stdin
/// according to the convention of each one (see `invoke_*` functions).
///
/// `timeout_secs` below 1 is replaced with [`DEFAULT_TIMEOUT_SECS`].
#[tauri::command]
pub async fn run_loop_agent(
    cli: String,
    model: String,
    cwd: String,
    system_prompt_path: Option<String>,
    user_input: String,
    timeout_secs: Option<u64>,
    session_id: Option<String>,
) -> Result<AgentResult, String> {
    let secs = timeout_secs
        .filter(|s| *s >= 1)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);

    let cli_lower = cli.to_ascii_lowercase();

    let join = tokio::task::spawn_blocking(move || -> Result<AgentResult, String> {
        let sid = session_id.as_deref();
        match cli_lower.as_str() {
            "claude" => invoke_claude(&model, &cwd, system_prompt_path.as_deref(), &user_input, sid),
            "codex" => invoke_codex(&model, &cwd, system_prompt_path.as_deref(), &user_input, sid),
            "opencode" => invoke_opencode(&model, &cwd, system_prompt_path.as_deref(), &user_input, sid),
            other => Err(format!("unsupported CLI: {other}")),
        }
    });

    match timeout(Duration::from_secs(secs), join).await {
        Ok(Ok(Ok(result))) => Ok(result),
        Ok(Ok(Err(err))) => Ok(AgentResult::empty_with_error(err)),
        Ok(Err(join_err)) => Err(format!("loop_agent join error: {join_err}")),
        Err(_) => Err(format!("timeout after {secs}s invoking {cli}")),
    }
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

/// Invokes `claude -p <input> --output-format json --model <model> [--append-system-prompt @file]`.
///
/// `claude` with `--output-format json` returns a single JSON object with the
/// shape (among other fields): `{ "result": "...", "session_id": "...",
/// "total_cost_usd": 0.0, "usage": { "input_tokens": 0, "output_tokens": 0 },
/// "is_error": false }`.
fn invoke_claude(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
) -> Result<AgentResult, String> {
    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg(user_input)
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg(model);

    if let Some(sid) = session_id {
        // Resume: claude reuses the previous session (including the system
        // prompt it already had). We do not re-append a system prompt: claude
        // preserves it.
        cmd.arg("--resume").arg(sid);
    } else if let Some(path) = system_prompt_path {
        // First turn with this session: we include the system prompt; future
        // resumes inherit it.
        let content =
            std::fs::read_to_string(path).map_err(|e| format!("could not read system prompt: {e}"))?;
        cmd.arg("--append-system-prompt").arg(content);
    }

    let output = run_command(cmd, cwd, "claude")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // claude returns the structured JSON error (404 model, throttling, etc.)
    // via stdout even with exit != 0. We try to parse first — `parse_claude_json`
    // already detects `is_error: true` and surfaces it in `AgentResult.error`
    // with the human text from the `result` field. We only fall back to stderr
    // if the stdout is not parseable JSON.
    if !stdout.trim().is_empty() {
        let parsed = parse_claude_json(&stdout)?;
        if !parsed.text.is_empty() || parsed.error.is_some() {
            return Ok(parsed);
        }
    }

    if !output.status.success() {
        return Ok(AgentResult::empty_with_error(format!(
            "claude exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    parse_claude_json(&stdout)
}

fn parse_claude_json(raw: &str) -> Result<AgentResult, String> {
    let value: serde_json::Value = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(e) => {
            return Ok(AgentResult::empty_with_error(format!(
                "malformed claude JSON: {e}"
            )));
        }
    };

    let text = value
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let session_id = value
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let cost_usd = value
        .get("total_cost_usd")
        .and_then(|v| v.as_f64())
        .or_else(|| value.get("cost_usd").and_then(|v| v.as_f64()));

    let usage = value.get("usage");
    let tokens_in = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_u64());
    let tokens_out = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_u64());

    let is_error = value
        .get("is_error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // claude uses `result` for the human-readable error message (e.g. "There's
    // an issue with the selected model (xxx)..."). If empty, fall back to
    // `api_error_status`. If that is also missing, a generic message.
    let error = if is_error {
        let detail = if !text.is_empty() {
            text.clone()
        } else if let Some(status) = value.get("api_error_status").and_then(|v| v.as_u64()) {
            format!("claude api error {status}")
        } else {
            "claude marked is_error=true".to_string()
        };
        Some(detail)
    } else {
        None
    };

    Ok(AgentResult {
        text,
        tokens_in,
        tokens_out,
        cost_usd,
        session_id,
        error,
    })
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

/// Invokes `codex exec --model <model> --json --output-last-message <tmpfile> <input>`.
///
/// `codex` with `--output-last-message` writes the last message from the agent
/// to the given file (plain text). With `--json` it additionally emits JSONL
/// events to stdout where we can look for usage/cost. We combine both: text
/// from the file, tokens/cost from the JSONL.
fn invoke_codex(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
) -> Result<AgentResult, String> {
    // Temp file for the last message. We open it within the run scope so it
    // is removed on exit (RAII from tempfile::NamedTempFile).
    let tmp = tempfile::Builder::new()
        .prefix("loop-codex-last-")
        .suffix(".txt")
        .tempfile()
        .map_err(|e| format!("could not create tempfile for codex: {e}"))?;
    let tmp_path: PathBuf = tmp.path().to_path_buf();

    // codex has no dedicated flag for a system prompt in one-shot exec mode;
    // it is concatenated to the input. In resume mode the session already has
    // the system prompt from the first turn, so we do NOT re-concatenate it.
    let full_input = if session_id.is_some() {
        user_input.to_string()
    } else {
        let mut s = String::new();
        if let Some(path) = system_prompt_path {
            let content = std::fs::read_to_string(path)
                .map_err(|e| format!("could not read system prompt: {e}"))?;
            s.push_str(&content);
            s.push_str("\n\n---\n\n");
        }
        s.push_str(user_input);
        s
    };

    let mut cmd = Command::new("codex");
    cmd.arg("exec");
    if let Some(sid) = session_id {
        // `codex exec resume [OPTIONS] <SESSION_ID> <PROMPT>` — subcommand.
        cmd.arg("resume")
            .arg("--model")
            .arg(model)
            .arg("--json")
            .arg("--output-last-message")
            .arg(&tmp_path)
            .arg(sid)
            .arg(&full_input);
    } else {
        cmd.arg("--model")
            .arg(model)
            .arg("--json")
            .arg("--output-last-message")
            .arg(&tmp_path)
            .arg(&full_input);
    }

    let output = run_command(cmd, cwd, "codex")?;

    if !output.status.success() {
        return Ok(AgentResult::empty_with_error(format!(
            "codex exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let last_message = std::fs::read_to_string(&tmp_path).unwrap_or_default();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    parse_codex_jsonl(&stdout, &last_message)
}

fn parse_codex_jsonl(stdout: &str, last_message: &str) -> Result<AgentResult, String> {
    // codex --json emits a sequence of JSON objects (JSONL). We walk through
    // them trying to capture the last one that has usage. Tolerant to empty
    // or non-JSON lines (misc logs).
    let mut tokens_in: Option<u64> = None;
    let mut tokens_out: Option<u64> = None;
    let mut cost_usd: Option<f64> = None;
    let mut session_id: Option<String> = None;

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };

        if let Some(sid) = value
            .get("session_id")
            .or_else(|| value.pointer("/msg/session_id"))
            .and_then(|v| v.as_str())
        {
            session_id = Some(sid.to_string());
        }

        // codex reports usage in `token_count` objects or similar; we cover
        // several reasonable paths without coupling to an exact version.
        let usage = value
            .get("usage")
            .or_else(|| value.pointer("/msg/usage"))
            .or_else(|| value.pointer("/info/usage"));
        if let Some(u) = usage {
            if let Some(v) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                tokens_in = Some(v);
            }
            if let Some(v) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                tokens_out = Some(v);
            }
        }

        if let Some(c) = value
            .get("total_cost_usd")
            .or_else(|| value.pointer("/msg/total_cost_usd"))
            .or_else(|| value.get("cost_usd"))
            .and_then(|v| v.as_f64())
        {
            cost_usd = Some(c);
        }
    }

    Ok(AgentResult {
        text: last_message.trim_end().to_string(),
        tokens_in,
        tokens_out,
        cost_usd,
        session_id,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

/// Invokes `opencode run --format json --model <model> <input>`.
///
/// `opencode run --format json` emits a JSONL event stream. We extract the
/// last message from the agent and, if available, the usage/cost from the
/// final event. If the event shape changes, the tolerance: the extractor only
/// assumes there is an event with `role == "assistant"` or `type == "message"`
/// carrying the final text.
fn invoke_opencode(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
) -> Result<AgentResult, String> {
    // In resume mode the session already has the system prompt from the first turn.
    let full_input = if session_id.is_some() {
        user_input.to_string()
    } else {
        let mut s = String::new();
        if let Some(path) = system_prompt_path {
            let content = std::fs::read_to_string(path)
                .map_err(|e| format!("could not read system prompt: {e}"))?;
            s.push_str(&content);
            s.push_str("\n\n---\n\n");
        }
        s.push_str(user_input);
        s
    };

    let mut cmd = Command::new("opencode");
    cmd.arg("run")
        .arg("--format")
        .arg("json")
        .arg("--model")
        .arg(model);
    if let Some(sid) = session_id {
        cmd.arg("--session").arg(sid);
    }
    cmd.arg(&full_input);

    let output = run_command(cmd, cwd, "opencode")?;

    if !output.status.success() {
        return Ok(AgentResult::empty_with_error(format!(
            "opencode exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_opencode_stream(&stdout)
}

fn parse_opencode_stream(raw: &str) -> Result<AgentResult, String> {
    let mut last_text: Option<String> = None;
    let mut tokens_in: Option<u64> = None;
    let mut tokens_out: Option<u64> = None;
    let mut cost_usd: Option<f64> = None;
    let mut session_id: Option<String> = None;
    let mut saw_any = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        saw_any = true;

        // The last assistant message is the agent output. The exact shape
        // varies per version: we try `role=assistant` with `content` as
        // string or as an array of parts with `text`.
        let role = value
            .get("role")
            .or_else(|| value.pointer("/message/role"))
            .and_then(|v| v.as_str());
        if matches!(role, Some("assistant")) {
            if let Some(text) = extract_opencode_text(&value) {
                last_text = Some(text);
            }
        }

        if let Some(sid) = value
            .get("session_id")
            .or_else(|| value.pointer("/session/id"))
            .and_then(|v| v.as_str())
        {
            session_id = Some(sid.to_string());
        }

        let usage = value
            .get("usage")
            .or_else(|| value.pointer("/message/usage"));
        if let Some(u) = usage {
            if let Some(v) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                tokens_in = Some(v);
            }
            if let Some(v) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                tokens_out = Some(v);
            }
        }

        if let Some(c) = value
            .get("cost_usd")
            .or_else(|| value.get("total_cost_usd"))
            .and_then(|v| v.as_f64())
        {
            cost_usd = Some(c);
        }
    }

    if !saw_any {
        // It was not JSONL — opencode may have emitted plain text (fallback).
        // We treat the whole stdout as the agent message.
        return Ok(AgentResult {
            text: raw.trim().to_string(),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
            session_id: None,
            error: None,
        });
    }

    Ok(AgentResult {
        text: last_text.unwrap_or_default(),
        tokens_in,
        tokens_out,
        cost_usd,
        session_id,
        error: None,
    })
}

fn extract_opencode_text(value: &serde_json::Value) -> Option<String> {
    let content = value
        .get("content")
        .or_else(|| value.pointer("/message/content"))?;

    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }

    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        for part in arr {
            if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                buf.push_str(t);
            } else if let Some(t) = part.as_str() {
                buf.push_str(t);
            }
        }
        if !buf.is_empty() {
            return Some(buf);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Runs `cmd` in `cwd` capturing stdout/stderr. Maps "binary not found"
/// (`ErrorKind::NotFound`) to a human-readable error that the frontend uses
/// to suggest the user install the CLI.
fn run_command(
    mut cmd: Command,
    cwd: &str,
    cli_name: &str,
) -> Result<std::process::Output, String> {
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let started_at = std::time::Instant::now();
    let result = cmd.output();
    let elapsed_ms = started_at.elapsed().as_millis();

    // Section 10.5 — optional invocation log. We append to a file in the
    // system temp dir for post-mortem debugging (we do not risk touching the
    // config dir from a spawn_blocking, so we use `std::env::temp_dir`).
    // Failing here must not break the CLI execution — all logger IO errors
    // are ignored.
    log_cli_invocation(cli_name, cwd, elapsed_ms, &result);

    result.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!(
            "CLI '{cli_name}' not found in PATH. Install it and reopen the app."
        ),
        _ => format!("error invoking {cli_name}: {e}"),
    })
}

/// Path to the CLI invocation log. Lives at `<temp>/polakapi-loop-cli.log` to
/// keep it predictable and without requiring the AppHandle of the Tauri
/// command (which would complicate passing the handle to `spawn_blocking`).
fn cli_log_path() -> PathBuf {
    std::env::temp_dir().join("polakapi-loop-cli.log")
}

/// Append a single line to the invocation log. Soft-fail: any IO error is
/// ignored — the logger is auxiliary and must not break the run flow.
fn log_cli_invocation(
    cli_name: &str,
    cwd: &str,
    elapsed_ms: u128,
    result: &std::io::Result<std::process::Output>,
) {
    let path = cli_log_path();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let line = match result {
        Ok(out) => format!(
            "[{now}] cli={cli_name} cwd={cwd} elapsed_ms={elapsed_ms} exit={} stdout_bytes={} stderr_bytes={}\n",
            out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string()),
            out.stdout.len(),
            out.stderr.len(),
        ),
        Err(e) => format!(
            "[{now}] cli={cli_name} cwd={cwd} elapsed_ms={elapsed_ms} error={e}\n"
        ),
    };

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_full_payload() {
        let raw = r#"{
            "result": "hello world",
            "session_id": "abc-123",
            "total_cost_usd": 0.0042,
            "usage": { "input_tokens": 12, "output_tokens": 5 },
            "is_error": false
        }"#;
        let parsed = parse_claude_json(raw).unwrap();
        assert_eq!(parsed.text, "hello world");
        assert_eq!(parsed.session_id.as_deref(), Some("abc-123"));
        assert_eq!(parsed.tokens_in, Some(12));
        assert_eq!(parsed.tokens_out, Some(5));
        assert!(parsed.cost_usd.unwrap() > 0.0);
        assert!(parsed.error.is_none());
    }

    #[test]
    fn parses_claude_with_is_error_true() {
        let raw = r#"{ "result": "failure", "is_error": true }"#;
        let parsed = parse_claude_json(raw).unwrap();
        assert_eq!(parsed.text, "failure");
        assert!(parsed.error.is_some());
    }

    #[test]
    fn claude_malformed_json_becomes_error() {
        let parsed = parse_claude_json("not json").unwrap();
        assert!(parsed.error.is_some());
        assert!(parsed.text.is_empty());
    }

    #[test]
    fn parses_codex_jsonl_extracts_usage_and_last_message() {
        let jsonl = "{\"msg\":{\"session_id\":\"sx\"}}\n{\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}\n";
        let parsed = parse_codex_jsonl(jsonl, "final answer").unwrap();
        assert_eq!(parsed.text, "final answer");
        assert_eq!(parsed.tokens_in, Some(7));
        assert_eq!(parsed.tokens_out, Some(3));
        assert_eq!(parsed.session_id.as_deref(), Some("sx"));
    }

    #[test]
    fn parses_opencode_stream_with_assistant_message() {
        let stream = r#"{"role":"user","content":"hi"}
{"role":"assistant","content":"hello from opencode","usage":{"input_tokens":4,"output_tokens":6}}
"#;
        let parsed = parse_opencode_stream(stream).unwrap();
        assert_eq!(parsed.text, "hello from opencode");
        assert_eq!(parsed.tokens_in, Some(4));
        assert_eq!(parsed.tokens_out, Some(6));
    }

    #[test]
    fn opencode_assistant_with_content_parts() {
        let stream = r#"{"role":"assistant","content":[{"text":"part one "},{"text":"part two"}]}
"#;
        let parsed = parse_opencode_stream(stream).unwrap();
        assert_eq!(parsed.text, "part one part two");
    }

    #[test]
    fn opencode_non_jsonl_fallbacks_to_plain_text() {
        let parsed = parse_opencode_stream("just plain text\n").unwrap();
        assert_eq!(parsed.text, "just plain text");
    }
}
