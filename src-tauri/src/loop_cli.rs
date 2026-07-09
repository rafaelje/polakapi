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
//! - The CLI is launched via `tokio::process::Command` with
//!   `kill_on_drop(true)` so that when `tokio::time::timeout` fires, dropping
//!   the wait future drops the `Child`, which sends `SIGKILL` to the
//!   subprocess. Without this the spawned CLI keeps running past the
//!   advertised timeout (see design doc, "Risks" section, hung subprocess row).
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
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
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
#[allow(clippy::too_many_arguments)]
pub async fn run_loop_agent(
    cli: String,
    model: String,
    cwd: String,
    run_id: String,
    system_prompt_path: Option<String>,
    user_input: String,
    timeout_secs: Option<u64>,
    session_id: Option<String>,
    // `effort` (optional): reasoning-effort tier. Recognized values:
    // `low` | `medium` | `high` | `xhigh`. Currently only `codex` maps this to
    // a CLI flag (`-c model_reasoning_effort=<effort>`); `claude` and
    // `opencode` log the intent and ignore it. `default` / `None` disables it.
    //
    // `run_dir_root` (optional): run-directory root under `cwd`. Defaults to
    // `.loop`; the `/adversarial review` feature passes `.adversarial` so it
    // can reuse this command without duplicating the whole scope-validation
    // logic.
    effort: Option<String>,
    run_dir_root: Option<String>,
) -> Result<AgentResult, String> {
    let secs = timeout_secs
        .filter(|s| *s >= 1)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);

    let cli_lower = cli.to_ascii_lowercase();
    let sid = session_id.as_deref();
    let timeout_dur = Duration::from_secs(secs);
    let root = run_dir_root.as_deref().unwrap_or(".loop");
    if !is_allowed_run_dir_root(root) {
        return Err(format!("invalid run_dir_root: {root}"));
    }
    let scope = validate_loop_invocation_scope(&cwd, &run_id, root, system_prompt_path.as_deref())?;
    let cwd = scope.cwd.to_string_lossy().to_string();
    let system_prompt_path = scope.system_prompt_path.as_deref();
    let effort = normalize_effort(effort.as_deref());

    // The per-CLI wrappers do their own spawn via `run_command`, which applies
    // `kill_on_drop(true)` and uses the same timeout. We forward the timeout
    // here instead of wrapping the future in another `tokio::time::timeout`:
    // doing that would mean we'd have to drop the inner future to actually
    // kill the child, and the cancellation point is already inside
    // `run_command` where the `Child` lives.
    match cli_lower.as_str() {
        "claude" => {
            invoke_claude(
                &model,
                &cwd,
                system_prompt_path,
                &user_input,
                sid,
                effort.as_deref(),
                timeout_dur,
            )
            .await
        }
        "codex" => {
            invoke_codex(
                &model,
                &cwd,
                system_prompt_path,
                &user_input,
                sid,
                effort.as_deref(),
                timeout_dur,
            )
            .await
        }
        "opencode" => {
            invoke_opencode(
                &model,
                &cwd,
                system_prompt_path,
                &user_input,
                sid,
                effort.as_deref(),
                timeout_dur,
            )
            .await
        }
        other => Err(format!("unsupported CLI: {other}")),
    }
}

fn is_allowed_run_dir_root(root: &str) -> bool {
    matches!(root, ".loop" | ".adversarial")
}

/// Only pass through recognized values; `default` and empty become `None` so
/// the CLI sees no flag at all (matches its own default).
fn normalize_effort(effort: Option<&str>) -> Option<String> {
    let raw = effort?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("default") {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    match lower.as_str() {
        "low" | "medium" | "high" | "xhigh" => Some(lower),
        _ => None,
    }
}

#[derive(Debug)]
struct InvocationScope {
    cwd: PathBuf,
    system_prompt_path: Option<String>,
}

fn validate_loop_invocation_scope(
    cwd: &str,
    run_id: &str,
    run_dir_root: &str,
    system_prompt_path: Option<&str>,
) -> Result<InvocationScope, String> {
    if !crate::loop_prompts::is_safe_run_id(run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }

    let cwd_path = PathBuf::from(cwd);
    let cwd_canon = cwd_path
        .canonicalize()
        .map_err(|e| format!("invalid cwd: {e}"))?;
    if !cwd_canon.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }

    let run_dir = cwd_canon.join(run_dir_root).join("runs").join(run_id);
    let run_dir_canon = run_dir
        .canonicalize()
        .map_err(|e| format!("invalid run directory: {e}"))?;
    if !run_dir_canon.is_dir() {
        return Err(format!("run directory is not a directory: {run_dir:?}"));
    }
    if !run_dir_canon.starts_with(&cwd_canon) {
        return Err("run directory escapes cwd".to_string());
    }

    let system_prompt_path = match system_prompt_path {
        Some(path) => Some(validate_system_prompt_path(path, &run_dir_canon)?),
        None => None,
    };

    Ok(InvocationScope {
        cwd: cwd_canon,
        system_prompt_path,
    })
}

fn validate_system_prompt_path(path: &str, run_dir: &Path) -> Result<String, String> {
    let prompt_path = PathBuf::from(path);
    let prompt_canon = prompt_path
        .canonicalize()
        .map_err(|e| format!("invalid system prompt path: {e}"))?;
    if !prompt_canon.is_file() {
        return Err(format!("system prompt path is not a file: {path}"));
    }

    let prompt_name = prompt_canon
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "system prompt path has no file name".to_string())?;
    if !crate::loop_prompts::is_known_prompt(prompt_name) {
        return Err(format!("system prompt not allowed: {prompt_name}"));
    }

    let prompts_dir = run_dir.join("prompts");
    let prompts_dir_canon = prompts_dir
        .canonicalize()
        .map_err(|e| format!("invalid prompts directory: {e}"))?;
    let parent = prompt_canon
        .parent()
        .ok_or_else(|| "system prompt path has no parent".to_string())?;
    if parent != prompts_dir_canon {
        return Err("system prompt must live in the run prompts directory".to_string());
    }

    Ok(prompt_canon.to_string_lossy().to_string())
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
async fn invoke_claude(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
    effort: Option<&str>,
    timeout_dur: Duration,
) -> Result<AgentResult, String> {
    // v1: `claude` has no stable one-shot flag equivalent to codex's
    // reasoning-effort tier. Log the intent and skip — the log line captures
    // it so /loop step 3 users can see it was requested but not applied.
    if effort.is_some() {
        // Non-fatal: the log line below records the requested effort.
    }
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
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("could not read system prompt: {e}"))?;
        cmd.arg("--append-system-prompt").arg(content);
    }

    let output = run_command(cmd, cwd, "claude", effort, timeout_dur).await?;

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
async fn invoke_codex(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
    effort: Option<&str>,
    timeout_dur: Duration,
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
    // codex accepts top-level config overrides via `-c key=value` before the
    // subcommand. Reasoning-effort tier is exposed as `model_reasoning_effort`.
    if let Some(level) = effort {
        cmd.arg("-c").arg(format!("model_reasoning_effort={level}"));
    }
    cmd.arg("exec");
    if let Some(sid) = session_id {
        // `codex exec resume [OPTIONS] <SESSION_ID> <PROMPT>` — subcommand.
        cmd.arg("resume")
            .arg("--model")
            .arg(model)
            .arg("--json")
            .arg("--output-last-message")
            .arg(&tmp_path)
            .arg("--")
            .arg(sid)
            .arg(&full_input);
    } else {
        cmd.arg("--model")
            .arg(model)
            .arg("--json")
            .arg("--output-last-message")
            .arg(&tmp_path)
            .arg("--")
            .arg(&full_input);
    }

    let output = run_command(cmd, cwd, "codex", effort, timeout_dur).await?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    if !output.status.success() {
        // codex emits its real error via the JSONL stream on stdout (e.g. a
        // 400 from the API); stderr just contains its "Reading input..."
        // banner. Pull the human-readable message out of the JSONL if we can.
        let detail = extract_codex_error(&stdout).unwrap_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stderr.is_empty() {
                format!("exit {}", output.status)
            } else {
                stderr
            }
        });
        return Ok(AgentResult::empty_with_error(format!("codex: {detail}")));
    }

    let last_message = std::fs::read_to_string(&tmp_path).unwrap_or_default();
    parse_codex_jsonl(&stdout, &last_message)
}

/// Extracts the most informative error line from codex's JSONL output. Codex
/// emits `{"type":"error","message":"..."}` and `{"type":"turn.failed",...}`
/// events with the API error inside; we prefer the first `error` message we
/// find, falling back to any error-typed item.
fn extract_codex_error(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        let type_field = value.get("type").and_then(|v| v.as_str());
        if type_field == Some("error") {
            if let Some(msg) = value.get("message").and_then(|v| v.as_str()) {
                return Some(unwrap_nested_json_message(msg));
            }
        }
        if type_field == Some("item.completed") {
            let item = value.pointer("/item")?;
            if item.get("type").and_then(|v| v.as_str()) == Some("error") {
                if let Some(msg) = item.get("message").and_then(|v| v.as_str()) {
                    return Some(unwrap_nested_json_message(msg));
                }
            }
        }
    }
    None
}

/// Codex sometimes stuffs the raw provider JSON into the `message` field
/// (`"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"...\"}}"`).
/// Peel that layer off so the user sees the sentence, not the payload.
fn unwrap_nested_json_message(msg: &str) -> String {
    if let Ok(inner) = serde_json::from_str::<serde_json::Value>(msg) {
        if let Some(deep) = inner.pointer("/error/message").and_then(|v| v.as_str()) {
            return deep.to_string();
        }
        if let Some(deep) = inner.get("message").and_then(|v| v.as_str()) {
            return deep.to_string();
        }
    }
    msg.to_string()
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
async fn invoke_opencode(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
    effort: Option<&str>,
    timeout_dur: Duration,
) -> Result<AgentResult, String> {
    // v1: opencode's provider-dependent effort mapping is out of scope. The
    // requested value flows to the log line so users can see it wasn't applied.
    let _ = effort;
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
    cmd.arg("--");
    cmd.arg(&full_input);

    let output = run_command(cmd, cwd, "opencode", effort, timeout_dur).await?;

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
    // Opencode's real JSONL shape (verified against `opencode run --format json`
    // at the current CLI version):
    //   {"type":"step_start", "sessionID": "...", "part": {...}}
    //   {"type":"text", "sessionID": "...", "part": {"type":"text", "text": "…the agent's answer…"}}
    //   {"type":"step_finish", "sessionID": "...", "part": {"tokens": {"input": 12860, "output": 17, ...}, "cost": 0.0182}}
    //
    // We concatenate every `type=text` part in order (the agent may emit its
    // reply across multiple text events) and pull tokens/cost from the last
    // `step_finish`. Older shapes (`role=assistant`, `usage.input_tokens`) are
    // still accepted as a fallback so downgrades don't silently break.
    let mut text_parts: Vec<String> = Vec::new();
    let mut tokens_in: Option<u64> = None;
    let mut tokens_out: Option<u64> = None;
    let mut cost_usd: Option<f64> = None;
    let mut session_id: Option<String> = None;
    let mut saw_any = false;
    let mut fallback_last_assistant: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        saw_any = true;

        let event_type = value.get("type").and_then(|v| v.as_str());

        if event_type == Some("text") {
            if let Some(text) = value
                .pointer("/part/text")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                text_parts.push(text.to_string());
            }
        }

        if event_type == Some("step_finish") {
            if let Some(tokens) = value.pointer("/part/tokens") {
                if let Some(v) = tokens.get("input").and_then(|v| v.as_u64()) {
                    tokens_in = Some(v);
                }
                if let Some(v) = tokens.get("output").and_then(|v| v.as_u64()) {
                    tokens_out = Some(v);
                }
            }
            if let Some(c) = value.pointer("/part/cost").and_then(|v| v.as_f64()) {
                cost_usd = Some(c);
            }
        }

        // Session id: opencode emits `sessionID` at the root of every event.
        if let Some(sid) = value
            .get("sessionID")
            .or_else(|| value.get("session_id"))
            .or_else(|| value.pointer("/session/id"))
            .and_then(|v| v.as_str())
        {
            session_id = Some(sid.to_string());
        }

        // Legacy fallback shape (kept so older CLI versions don't regress).
        let role = value
            .get("role")
            .or_else(|| value.pointer("/message/role"))
            .and_then(|v| v.as_str());
        if matches!(role, Some("assistant")) {
            if let Some(text) = extract_opencode_text(&value) {
                fallback_last_assistant = Some(text);
            }
        }
        if let Some(u) = value
            .get("usage")
            .or_else(|| value.pointer("/message/usage"))
        {
            if let Some(v) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                tokens_in.get_or_insert(v);
            }
            if let Some(v) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                tokens_out.get_or_insert(v);
            }
        }
        if let Some(c) = value
            .get("cost_usd")
            .or_else(|| value.get("total_cost_usd"))
            .and_then(|v| v.as_f64())
        {
            cost_usd.get_or_insert(c);
        }
    }

    if !saw_any {
        // Not JSONL — opencode may have emitted plain text. Treat stdout as the
        // agent message so the caller has *something* to parse.
        return Ok(AgentResult {
            text: raw.trim().to_string(),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
            session_id: None,
            error: None,
        });
    }

    let text = if !text_parts.is_empty() {
        text_parts.join("")
    } else {
        fallback_last_assistant.unwrap_or_default()
    };

    Ok(AgentResult {
        text,
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

/// Runs `cmd` in `cwd` capturing stdout/stderr, with a hard timeout that
/// actually kills the subprocess on expiry.
///
/// Implementation note: `tokio::time::timeout(.., child.wait_with_output())`
/// drops the wait future when the timeout fires. We set `kill_on_drop(true)`
/// on the `Command` so dropping the `Child` (which the wait future owns)
/// sends `SIGKILL` synchronously to the subprocess. Without this the
/// advertised timeout would be a lie — the future returns `Err` but the CLI
/// keeps running in the background.
///
/// Maps "binary not found" (`ErrorKind::NotFound`) to a human-readable error
/// that the frontend uses to suggest the user install the CLI.
async fn run_command(
    mut cmd: Command,
    cwd: &str,
    cli_name: &str,
    effort: Option<&str>,
    timeout_dur: Duration,
) -> Result<std::process::Output, String> {
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let started_at = std::time::Instant::now();

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let elapsed_ms = started_at.elapsed().as_millis();
            let io_result: std::io::Result<std::process::Output> =
                Err(std::io::Error::new(e.kind(), e.to_string()));
            log_cli_invocation(cli_name, cwd, effort, elapsed_ms, &io_result);
            return Err(match e.kind() {
                std::io::ErrorKind::NotFound => {
                    format!("CLI '{cli_name}' not found in PATH. Install it and reopen the app.")
                }
                _ => format!("error invoking {cli_name}: {e}"),
            });
        }
    };

    // Section 10.5 — optional invocation log. We append to a file in the
    // system temp dir for post-mortem debugging. Failing here must not break
    // the CLI execution — all logger IO errors are ignored.
    match timeout(timeout_dur, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let elapsed_ms = started_at.elapsed().as_millis();
            let io_result: std::io::Result<std::process::Output> = Ok(output);
            log_cli_invocation(cli_name, cwd, effort, elapsed_ms, &io_result);
            // io_result is Ok, so unwrap is safe.
            io_result.map_err(|e| format!("error waiting on {cli_name}: {e}"))
        }
        Ok(Err(e)) => {
            let elapsed_ms = started_at.elapsed().as_millis();
            let io_result: std::io::Result<std::process::Output> =
                Err(std::io::Error::new(e.kind(), e.to_string()));
            log_cli_invocation(cli_name, cwd, effort, elapsed_ms, &io_result);
            Err(format!("error waiting on {cli_name}: {e}"))
        }
        Err(_elapsed) => {
            // The wait future is dropped here; `kill_on_drop(true)` sends
            // SIGKILL synchronously and tokio reaps the child on a background
            // task. The subprocess is gone before we return.
            let elapsed_ms = started_at.elapsed().as_millis();
            let io_result: std::io::Result<std::process::Output> = Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("timeout after {}s", timeout_dur.as_secs()),
            ));
            log_cli_invocation(cli_name, cwd, effort, elapsed_ms, &io_result);
            Err(format!(
                "timeout after {}s invoking {cli_name}",
                timeout_dur.as_secs()
            ))
        }
    }
}

/// Path to the CLI invocation log. Lives at `<temp>/polakapi-loop-cli.log` to
/// keep it predictable and without requiring the AppHandle of the Tauri
/// command.
fn cli_log_path() -> PathBuf {
    std::env::temp_dir().join("polakapi-loop-cli.log")
}

/// Append a single line to the invocation log. Soft-fail: any IO error is
/// ignored — the logger is auxiliary and must not break the run flow.
fn log_cli_invocation(
    cli_name: &str,
    cwd: &str,
    effort: Option<&str>,
    elapsed_ms: u128,
    result: &std::io::Result<std::process::Output>,
) {
    let path = cli_log_path();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let effort_field = effort.unwrap_or("-");

    let line = match result {
        Ok(out) => format!(
            "[{now}] cli={cli_name} cwd={cwd} effort={effort_field} elapsed_ms={elapsed_ms} exit={} stdout_bytes={} stderr_bytes={}\n",
            out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string()),
            out.stdout.len(),
            out.stderr.len(),
        ),
        Err(e) => format!(
            "[{now}] cli={cli_name} cwd={cwd} effort={effort_field} elapsed_ms={elapsed_ms} error={e}\n"
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
    fn extracts_codex_error_from_top_level_event() {
        let stdout = concat!(
            r#"{"type":"thread.started","thread_id":"x"}"#,
            "\n",
            r#"{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5' model is not supported when using Codex with a ChatGPT account.\"}}"}"#,
            "\n"
        );
        let err = extract_codex_error(stdout).unwrap();
        assert!(err.contains("not supported when using Codex with a ChatGPT account"));
    }

    #[test]
    fn extracts_codex_error_from_item_completed_error() {
        let stdout =
            r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5` not found."}}"#;
        let err = extract_codex_error(stdout).unwrap();
        assert_eq!(err, "Model metadata for `gpt-5` not found.");
    }

    #[test]
    fn returns_none_when_no_error_present() {
        let stdout = r#"{"type":"turn.completed","usage":{"input_tokens":10}}"#;
        assert!(extract_codex_error(stdout).is_none());
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
    fn parses_opencode_current_shape_text_and_step_finish() {
        // Real shape captured from `opencode run --format json` (2026-07).
        let stream = concat!(
            r#"{"type":"step_start","sessionID":"ses_x","part":{"type":"step-start"}}"#,
            "\n",
            r#"{"type":"text","sessionID":"ses_x","part":{"type":"text","text":"```json\n{\"pass\":\"critic\"}\n```"}}"#,
            "\n",
            r#"{"type":"step_finish","sessionID":"ses_x","part":{"type":"step-finish","tokens":{"input":12860,"output":17,"reasoning":28},"cost":0.0182}}"#,
            "\n"
        );
        let parsed = parse_opencode_stream(stream).unwrap();
        assert!(parsed.text.contains("```json"));
        assert!(parsed.text.contains("\"pass\":\"critic\""));
        assert_eq!(parsed.tokens_in, Some(12860));
        assert_eq!(parsed.tokens_out, Some(17));
        assert!((parsed.cost_usd.unwrap() - 0.0182).abs() < 1e-9);
        assert_eq!(parsed.session_id.as_deref(), Some("ses_x"));
    }

    #[test]
    fn concatenates_multiple_text_parts_in_order() {
        let stream = concat!(
            r#"{"type":"text","part":{"type":"text","text":"first "}}"#,
            "\n",
            r#"{"type":"text","part":{"type":"text","text":"second"}}"#,
            "\n"
        );
        let parsed = parse_opencode_stream(stream).unwrap();
        assert_eq!(parsed.text, "first second");
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

    #[test]
    fn invocation_scope_accepts_run_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let run_prompts = tmp.path().join(".loop/runs/run-1/prompts");
        std::fs::create_dir_all(&run_prompts).unwrap();
        let prompt = run_prompts.join("analysis.md");
        std::fs::write(&prompt, "prompt").unwrap();

        let scope = validate_loop_invocation_scope(
            tmp.path().to_str().unwrap(),
            "run-1",
            ".loop",
            Some(prompt.to_str().unwrap()),
        )
        .unwrap();

        assert_eq!(scope.cwd, tmp.path().canonicalize().unwrap());
        assert_eq!(
            scope.system_prompt_path.as_deref(),
            Some(prompt.canonicalize().unwrap().to_str().unwrap())
        );
    }

    #[test]
    fn invocation_scope_rejects_prompt_outside_run() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".loop/runs/run-1/prompts")).unwrap();
        let prompt = tmp.path().join("analysis.md");
        std::fs::write(&prompt, "prompt").unwrap();

        let err = validate_loop_invocation_scope(
            tmp.path().to_str().unwrap(),
            "run-1",
            ".loop",
            Some(prompt.to_str().unwrap()),
        )
        .unwrap_err();

        assert!(err.contains("run prompts directory"));
    }

    #[test]
    fn invocation_scope_rejects_unsafe_run_id() {
        let tmp = tempfile::tempdir().unwrap();
        let err =
            validate_loop_invocation_scope(tmp.path().to_str().unwrap(), "../x", ".loop", None)
                .unwrap_err();
        assert!(err.contains("invalid run_id"));
    }

    #[test]
    fn invocation_scope_accepts_adversarial_root() {
        let tmp = tempfile::tempdir().unwrap();
        let run_prompts = tmp.path().join(".adversarial/runs/run-x/prompts");
        std::fs::create_dir_all(&run_prompts).unwrap();
        let prompt = run_prompts.join("adversarial-critic.md");
        std::fs::write(&prompt, "prompt").unwrap();

        let scope = validate_loop_invocation_scope(
            tmp.path().to_str().unwrap(),
            "run-x",
            ".adversarial",
            Some(prompt.to_str().unwrap()),
        )
        .unwrap();

        assert_eq!(scope.cwd, tmp.path().canonicalize().unwrap());
        assert!(scope.system_prompt_path.is_some());
    }

    #[test]
    fn allowed_run_dir_roots() {
        assert!(is_allowed_run_dir_root(".loop"));
        assert!(is_allowed_run_dir_root(".adversarial"));
        assert!(!is_allowed_run_dir_root(".."));
        assert!(!is_allowed_run_dir_root("/etc"));
        assert!(!is_allowed_run_dir_root("loop"));
    }

    #[test]
    fn normalizes_effort_values() {
        assert_eq!(normalize_effort(Some("high")).as_deref(), Some("high"));
        assert_eq!(normalize_effort(Some("HIGH")).as_deref(), Some("high"));
        assert_eq!(normalize_effort(Some("xhigh")).as_deref(), Some("xhigh"));
        assert_eq!(normalize_effort(Some("default")), None);
        assert_eq!(normalize_effort(Some("")), None);
        assert_eq!(normalize_effort(Some("nonsense")), None);
        assert_eq!(normalize_effort(None), None);
    }
}
