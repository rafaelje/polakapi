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

use std::path::PathBuf;
use std::time::Duration;

use crate::platform_command;
use serde::{Deserialize, Serialize};

mod parsers;
mod process;
mod scope;

use parsers::{
    extract_codex_error, parse_claude_json, parse_codex_jsonl, parse_cursor_json,
    parse_opencode_stream,
};
use process::run_command;
use scope::{is_allowed_run_dir_root, normalize_effort, validate_loop_invocation_scope};

#[cfg(test)]
mod tests;

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
    let cwd = platform_command::external_path(&scope.cwd)
        .to_string_lossy()
        .to_string();
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
                false,
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
                false,
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

/// One-shot invocation without the `/loop` run-scope validation. Used by
/// features (e.g. `/skills`) that need a single normalized answer from a CLI
/// against an arbitrary working directory.
/// Every CLI here is invoked read-only. The caller (`/skills` explain) feeds
/// the agent file content it did not author — skills arrive from marketplaces
/// and cloned repos — so the run must not be able to edit or execute anything
/// even if that content tries to talk the model into it.
///
/// `opencode` is deliberately absent: it is the one supported CLI with no
/// verified read-only mode, so it is not offered for this path.
pub(crate) async fn run_one_shot(
    cli: &str,
    model: &str,
    cwd: &str,
    user_input: &str,
    timeout_dur: Duration,
) -> Result<AgentResult, String> {
    match cli.to_ascii_lowercase().as_str() {
        "claude" => {
            invoke_claude(model, cwd, None, user_input, None, None, true, timeout_dur).await
        }
        "codex" => invoke_codex(model, cwd, None, user_input, None, None, true, timeout_dur).await,
        "cursor" => invoke_cursor(model, cwd, user_input, timeout_dur).await,
        other => Err(format!("unsupported CLI: {other}")),
    }
}

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

/// Invokes `cursor-agent -p <input> --mode ask --trust --output-format json`.
///
/// `--mode ask` is the CLI's own read-only Q&A mode ("analyze and explain, no
/// edits"), which is exactly this call. `--trust` only suppresses the
/// workspace-trust prompt so the run is non-interactive; it grants no write
/// access on its own.
async fn invoke_cursor(
    model: &str,
    cwd: &str,
    user_input: &str,
    timeout_dur: Duration,
) -> Result<AgentResult, String> {
    let mut cmd = platform_command::tokio_command("cursor-agent")?;
    cmd.arg("-p")
        .arg(user_input)
        .arg("--mode")
        .arg("ask")
        .arg("--trust")
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg(model);

    let output = run_command(cmd, cwd, "cursor", None, timeout_dur).await?;
    if !output.status.success() {
        return Ok(AgentResult::empty_with_error(format!(
            "cursor exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    parse_cursor_json(&String::from_utf8_lossy(&output.stdout))
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
#[allow(clippy::too_many_arguments)]
async fn invoke_claude(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
    effort: Option<&str>,
    // Restrict the run to reading. Set by `run_one_shot`, never by `/loop`.
    read_only: bool,
    timeout_dur: Duration,
) -> Result<AgentResult, String> {
    // v1: `claude` has no stable one-shot flag equivalent to codex's
    // reasoning-effort tier. Log the intent and skip — the log line captures
    // it so /loop step 3 users can see it was requested but not applied.
    if effort.is_some() {
        // Non-fatal: the log line below records the requested effort.
    }
    let mut cmd = platform_command::tokio_command("claude")?;
    cmd.arg("-p")
        .arg(user_input)
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg(model);
    if read_only {
        cmd.arg("--allowedTools").arg("Read");
    }

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

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

/// Invokes `codex exec --model <model> --json --output-last-message <tmpfile> <input>`.
///
/// `codex` with `--output-last-message` writes the last message from the agent
/// to the given file (plain text). With `--json` it additionally emits JSONL
/// events to stdout where we can look for usage/cost. We combine both: text
/// from the file, tokens/cost from the JSONL.
#[allow(clippy::too_many_arguments)]
async fn invoke_codex(
    model: &str,
    cwd: &str,
    system_prompt_path: Option<&str>,
    user_input: &str,
    session_id: Option<&str>,
    effort: Option<&str>,
    // Restrict the run to reading. Set by `run_one_shot`, never by `/loop`.
    read_only: bool,
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

    let mut cmd = platform_command::tokio_command("codex")?;
    // codex accepts top-level config overrides via `-c key=value` before the
    // subcommand. Reasoning-effort tier is exposed as `model_reasoning_effort`.
    if let Some(level) = effort {
        cmd.arg("-c").arg(format!("model_reasoning_effort={level}"));
    }
    if read_only {
        // Already the default for `codex exec`, but stated explicitly so a
        // user config that loosens it cannot widen this path.
        cmd.arg("-c").arg("sandbox_mode=read-only");
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

    let mut cmd = platform_command::tokio_command("opencode")?;
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

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
