mod process;
mod transcript;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::db::Db;
use crate::platform_command;
use crate::pty::PtyStore;

pub use process::ProcessStats;
pub use transcript::{ContextBreakdown, ContextEntry, SearchHit};

// Backs the /context window: what each running agent CLI currently holds in its
// context, read from the transcript that CLI writes to disk.
//
// Claude Code keeps one transcript per project directory
// (~/.claude/projects/<cwd-slug>/<session>.jsonl) and Codex one rollout per
// session (~/.codex/sessions/<y>/<m>/<d>/). Claude's is parsed into readable
// entries; for Codex only the token totals are read, because its rollout layout
// has not been verified against a real file.
//
// Only panes running an allowlisted AI CLI appear here — `PtyStore::agent_panes`
// filters shells out at the source, so the window never has to guess.

const DEFAULT_CONTEXT_LIMIT: u64 = 200_000;
/// Codex records the cwd inside the rollout, so attaching a pane to one means
/// opening candidates newest-first. Both bounds keep that scan cheap.
const MAX_CODEX_SCAN: usize = 200;
const MAX_SCAN_DEPTH: usize = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub pty_id: String,
    pub cli: String,
    pub cwd: Option<String>,
    /// Last path component of the cwd, for grouping in the list.
    pub project: Option<String>,
    pub model: Option<String>,
    pub context_tokens: u64,
    pub context_limit: u64,
    /// False when no transcript could be located, or the CLI writes none we can
    /// read. The window shows the row anyway, with the reason.
    pub readable: bool,
    /// RSS, CPU and uptime of the pane's whole process tree.
    pub process: ProcessStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextDetail {
    pub summary: AgentSummary,
    pub breakdown: ContextBreakdown,
    pub entries: Vec<ContextEntry>,
    /// Set when there is nothing to read, explaining why.
    pub note: Option<String>,
}

#[tauri::command(async)]
pub fn agent_context_list(
    store: State<'_, Arc<PtyStore>>,
    db: State<'_, StdMutex<Db>>,
) -> Result<Vec<AgentSummary>, String> {
    let stats = process::sample(&store.session_pids());
    let mut out: Vec<AgentSummary> = store
        .agent_panes()
        .into_iter()
        .map(|pane| {
            let pane_stats = stats.get(&pane.pty_id).copied().unwrap_or_default();
            summarize(
                &pane.pty_id,
                &pane.cli,
                pane.cwd.as_deref(),
                &db,
                pane_stats,
            )
        })
        .collect();
    out.sort_by(|a, b| a.project.cmp(&b.project).then_with(|| a.cli.cmp(&b.cli)));
    Ok(out)
}

#[tauri::command(async)]
pub fn agent_context_detail(
    store: State<'_, Arc<PtyStore>>,
    db: State<'_, StdMutex<Db>>,
    pty_id: String,
) -> Result<ContextDetail, String> {
    let pane = store
        .agent_panes()
        .into_iter()
        .find(|pane| pane.pty_id == pty_id)
        .ok_or_else(|| format!("no running agent for pane {pty_id}"))?;
    let stats = process::sample(&store.session_pids())
        .get(&pane.pty_id)
        .copied()
        .unwrap_or_default();
    let summary = summarize(&pane.pty_id, &pane.cli, pane.cwd.as_deref(), &db, stats);

    if pane.cli != "claude" {
        return Ok(ContextDetail {
            summary,
            breakdown: ContextBreakdown::default(),
            entries: Vec::new(),
            note: Some(format!(
                "Reading context content is implemented for Claude Code only. \
                 {} writes a transcript in a layout polakapi has not verified yet.",
                pane.cli
            )),
        });
    }

    let Some(path) = claude_transcript(&pane.pty_id, pane.cwd.as_deref(), &db) else {
        let session = current_session(&pane.pty_id, &db);
        return Ok(ContextDetail {
            summary,
            breakdown: ContextBreakdown::default(),
            entries: Vec::new(),
            // Two different situations, and saying which one saves the user
            // from reading an empty panel as a failure.
            note: Some(match session {
                Some(session) => format!(
                    "Session {session} has not written anything yet — it starts empty after \
                     /clear or a fresh start. Its content appears here after the first exchange."
                ),
                None => "No session recorded for this terminal yet. It appears once the agent \
                         starts, which needs the polakapi hooks enabled in Settings."
                    .to_string(),
            }),
        });
    };
    let Some(parsed) = transcript::parse(&path) else {
        return Ok(ContextDetail {
            summary,
            breakdown: ContextBreakdown::default(),
            entries: Vec::new(),
            note: Some(format!("Could not read {}", path.display())),
        });
    };
    Ok(ContextDetail {
        summary,
        breakdown: parsed.breakdown,
        entries: parsed.entries,
        note: None,
    })
}

/// Regex search across the full entry bodies. Runs in Rust because the listing
/// only carries 400-character previews — searching those in the window would
/// silently miss every match past the cut.
#[tauri::command(async)]
pub fn agent_context_search(
    store: State<'_, Arc<PtyStore>>,
    db: State<'_, StdMutex<Db>>,
    pty_id: String,
    pattern: String,
) -> Result<Vec<SearchHit>, String> {
    let pane = store
        .agent_panes()
        .into_iter()
        .find(|pane| pane.pty_id == pty_id)
        .ok_or_else(|| format!("no running agent for pane {pty_id}"))?;
    let Some(path) = claude_transcript(&pane.pty_id, pane.cwd.as_deref(), &db) else {
        return Ok(Vec::new());
    };
    transcript::search(&path, &pattern)
}

/// Full text of one entry, fetched on demand so the listing stays small.
#[tauri::command(async)]
pub fn agent_context_entry(
    store: State<'_, Arc<PtyStore>>,
    db: State<'_, StdMutex<Db>>,
    pty_id: String,
    entry_id: usize,
) -> Result<Option<String>, String> {
    let pane = store
        .agent_panes()
        .into_iter()
        .find(|pane| pane.pty_id == pty_id)
        .ok_or_else(|| format!("no running agent for pane {pty_id}"))?;
    let Some(path) = claude_transcript(&pane.pty_id, pane.cwd.as_deref(), &db) else {
        return Ok(None);
    };
    Ok(transcript::entry_body(&path, entry_id))
}

fn summarize(
    pty_id: &str,
    cli: &str,
    cwd: Option<&str>,
    db: &State<'_, StdMutex<Db>>,
    stats: ProcessStats,
) -> AgentSummary {
    let project = cwd
        .and_then(|dir| Path::new(dir).file_name())
        .and_then(|name| name.to_str())
        .map(str::to_string);
    let mut summary = AgentSummary {
        pty_id: pty_id.to_string(),
        cli: cli.to_string(),
        cwd: cwd.map(str::to_string),
        project,
        model: None,
        context_tokens: 0,
        context_limit: 0,
        readable: false,
        process: stats,
    };
    match cli {
        "claude" => {
            if let Some(path) = claude_transcript(pty_id, cwd, db) {
                if let Some((model, tokens)) = claude_head(&path) {
                    summary.context_limit = claude_context_limit(model.as_deref());
                    summary.model = model;
                    summary.context_tokens = tokens;
                    summary.readable = true;
                }
            }
        }
        "codex" => {
            if let Some(path) = cwd.and_then(codex_transcript_path) {
                if let Some(head) = codex_head(&path) {
                    summary.model = head.model;
                    summary.context_tokens = head.tokens;
                    // Codex reports its own window, so there is nothing to guess.
                    summary.context_limit = head.context_window.unwrap_or(0);
                }
            }
        }
        // cursor-agent keeps no token accounting in its session store; the only
        // model on disk is the CLI's global selection.
        "cursor-agent" => summary.model = cursor_model(),
        _ => {}
    }
    summary
}

/// The model cursor-agent is configured to use, from `~/.cursor/cli-config.json`.
/// Global rather than per-session, so it can lag a mid-session switch.
fn cursor_model() -> Option<String> {
    let path = platform_command::user_home_dir()?
        .join(".cursor")
        .join("cli-config.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let config: Value = serde_json::from_str(&raw).ok()?;
    for pointer in ["/model/displayName", "/model/modelId"] {
        if let Some(name) = config.pointer(pointer).and_then(Value::as_str) {
            return Some(name.to_string());
        }
    }
    None
}

/// Context window for a **Claude** model id; `0` means unknown.
///
/// Matched by version prefix rather than family name on purpose: Sonnet 4.6 and
/// later carry 1M while Sonnet 4.5 and earlier carry 200k, so a bare "sonnet"
/// match would quintuple the reported window for older models.
///
/// Only `claude-*` ids get the 200k fallback. Every other vendor reports zero,
/// because inventing a limit for a model we do not know produces a confident
/// wrong percentage — the UI shows the raw token count instead.
fn claude_context_limit(model: Option<&str>) -> u64 {
    const MILLION: &[&str] = &[
        "claude-fable-",
        "claude-mythos-",
        "claude-opus-5",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
    ];
    let Some(model) = model else {
        return DEFAULT_CONTEXT_LIMIT;
    };
    if MILLION.iter().any(|prefix| model.starts_with(prefix)) {
        return 1_000_000;
    }
    if model.starts_with("claude-") {
        return DEFAULT_CONTEXT_LIMIT;
    }
    0
}

/// Newest model and prompt size from the last assistant turn. The prompt size is
/// what actually occupies the window on the next turn: fresh input plus both
/// cache halves.
fn claude_head(path: &Path) -> Option<(Option<String>, u64)> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let mut model = None;
    let mut tokens = 0u64;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if let Some(found) = event.pointer("/message/model").and_then(Value::as_str) {
            model = Some(found.to_string());
        }
        if let Some(usage) = event.pointer("/message/usage") {
            tokens = as_u64(usage.get("input_tokens"))
                .saturating_add(as_u64(usage.get("cache_read_input_tokens")))
                .saturating_add(as_u64(usage.get("cache_creation_input_tokens")));
        }
    }
    Some((model, tokens))
}

struct CodexHead {
    model: Option<String>,
    tokens: u64,
    context_window: Option<u64>,
}

/// Codex reports `input_tokens` as the whole input including the cached part,
/// so it is the window occupancy as-is. Matches `usage/codex_jsonl.rs`.
///
/// `model_context_window` is read straight from the rollout when codex writes
/// it, which beats any table we could hardcode. Unverified against a real file:
/// when the field is absent the limit stays unknown rather than being guessed.
fn codex_head(path: &Path) -> Option<CodexHead> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let mut head = CodexHead {
        model: None,
        tokens: 0,
        context_window: None,
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        if event.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        if let Some(found) = event.pointer("/payload/info/model").and_then(Value::as_str) {
            head.model = Some(found.to_string());
        }
        if let Some(window) = event
            .pointer("/payload/info/model_context_window")
            .and_then(Value::as_u64)
        {
            head.context_window = Some(window);
        }
        if let Some(last) = event.pointer("/payload/info/last_token_usage") {
            head.tokens = as_u64(last.get("input_tokens"));
        }
    }
    Some(head)
}

fn as_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n.max(0) as u64)))
        .unwrap_or(0)
}

/// Claude Code stores each project's transcripts in a directory named after the
/// cwd with every non-alphanumeric character replaced by `-`
/// (`/home/u/repos/app` -> `-home-u-repos-app`).
fn cwd_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn current_session(pty_id: &str, db: &State<'_, StdMutex<Db>>) -> Option<String> {
    db.lock()
        .ok()
        .and_then(|db| db.cli_session_id_for_pty(pty_id).ok().flatten())
}

fn claude_transcript(
    pty_id: &str,
    cwd: Option<&str>,
    db: &State<'_, StdMutex<Db>>,
) -> Option<PathBuf> {
    let dir = platform_command::user_home_dir()?
        .join(".claude")
        .join("projects")
        .join(cwd_slug(cwd?));
    let session_id = current_session(pty_id, db);
    // When the session is known, only its own transcript will do. A session
    // that has not written one yet (a fresh `/clear`) shows as empty rather than
    // borrowing the previous session's, which is what the newest file would be.
    match session_id {
        Some(id) => Some(dir.join(format!("{id}.jsonl"))).filter(|path| path.is_file()),
        None => newest_jsonl(&dir),
    }
}

fn newest_jsonl(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if best.as_ref().is_none_or(|(seen, _)| modified > *seen) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, path)| path)
}

fn codex_transcript_path(cwd: &str) -> Option<PathBuf> {
    let root = platform_command::user_home_dir()?
        .join(".codex")
        .join("sessions");
    let mut files = Vec::new();
    collect_jsonl(&root, &mut files, 0);
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    files
        .into_iter()
        .take(MAX_CODEX_SCAN)
        .find(|(_, path)| codex_cwd(path).as_deref() == Some(cwd))
        .map(|(_, path)| path)
}

fn collect_jsonl(dir: &Path, out: &mut Vec<(SystemTime, PathBuf)>, depth: usize) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_jsonl(&entry.path(), out, depth + 1);
        } else if entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                out.push((modified, entry.path()));
            }
        }
    }
}

/// Reads the `session_meta` header line and returns the cwd it recorded. Codex
/// has moved this field between releases, so accept the shapes seen in the wild
/// rather than binding to one.
fn codex_cwd(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(8) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        for pointer in ["/payload/cwd", "/payload/workspace/cwd", "/cwd"] {
            if let Some(cwd) = event.pointer(pointer).and_then(Value::as_str) {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_cwd_like_claude_code_does() {
        assert_eq!(cwd_slug("/home/u/repos/app"), "-home-u-repos-app");
        // A dot becomes its own dash, which is why `.local` yields `--local`.
        assert_eq!(cwd_slug("/home/u/.local/x"), "-home-u--local-x");
    }

    #[test]
    fn million_token_models_are_matched_by_version_not_by_family() {
        for model in [
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-opus-4-6",
            "claude-fable-5-1",
            "claude-mythos-5-1",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
        ] {
            assert_eq!(claude_context_limit(Some(model)), 1_000_000, "{model}");
        }
        // The versions that would break a bare family-name match.
        for model in ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"] {
            assert_eq!(claude_context_limit(Some(model)), 200_000, "{model}");
        }
        assert_eq!(claude_context_limit(None), DEFAULT_CONTEXT_LIMIT);
    }

    #[test]
    fn non_claude_models_report_an_unknown_window_rather_than_a_guess() {
        assert_eq!(claude_context_limit(Some("gpt-5-codex")), 0);
        assert_eq!(claude_context_limit(Some("grok-4.6")), 0);
        // An unrecognised Claude id still gets the conservative floor.
        assert_eq!(
            claude_context_limit(Some("claude-something-new")),
            DEFAULT_CONTEXT_LIMIT
        );
    }
}
