use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sysinfo::{ProcessesToUpdate, System};
use tauri::State;

use crate::db::Db;
use crate::memory::tree_maps;
use crate::platform_command;
use crate::pty::PtyStore;

// Per-pane "what is this agent holding right now" snapshot for the agent
// context panel in the right sidebar.
//
// Two independent halves, deliberately decoupled so one failing never blanks
// the other:
//   - conversation: parsed from the CLI's own transcript. Claude Code writes
//     one per project (~/.claude/projects/<cwd-slug>/<session>.jsonl) and Codex
//     one rollout per session (~/.codex/sessions/<y>/<m>/<d>/), so any other
//     CLI reports `source: "none"` and the UI hides that half.
//   - process: RSS of the whole PTY process tree plus CPU and uptime, from
//     sysinfo. Available for every pane regardless of CLI.
//
// Claude transcripts are located by the `cli_session_id` the capture hooks
// record in the `sessions` table, falling back to the most recently modified
// file in the directory matching the pane's cwd when hooks are not installed.
// Codex records the cwd inside the rollout instead, so its files are scanned
// newest-first until one reports a matching cwd.

const MB: u64 = 1024 * 1024;
const DEFAULT_CONTEXT_LIMIT: u64 = 200_000;
/// Cap on transcript bytes parsed per pane so a very long session cannot
/// stall the poll. Reading the tail would truncate mid-line, so we read from
/// the start and stop once the budget is spent, keeping the newest usage seen.
const MAX_TRANSCRIPT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FILES: usize = 8;
const MAX_TOOLS: usize = 8;
/// Codex records the cwd inside the rollout, so attaching a pane to one means
/// opening candidates newest-first. Both bounds keep that scan cheap.
const MAX_CODEX_SCAN: usize = 200;
const MAX_SCAN_DEPTH: usize = 6;

/// One live pane the frontend wants context for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneQuery {
    pub pty_id: String,
    pub cli_id: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCount {
    pub name: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneContext {
    pub pty_id: String,
    /// "claude" or "codex" when a transcript was parsed, "none" when the CLI
    /// keeps no local transcript (opencode, cursor) or none was found.
    pub source: String,
    pub model: Option<String>,
    pub context_tokens: u64,
    pub context_limit: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub cost_usd: Option<f64>,
    pub turns: u64,
    pub tools: Vec<ToolCount>,
    pub files: Vec<String>,
    pub session_id: Option<String>,
    pub rss_mb: u64,
    pub cpu_percent: f32,
    pub uptime_secs: u64,
    pub pid: Option<u32>,
}

impl PaneContext {
    fn empty(pty_id: String) -> Self {
        Self {
            pty_id,
            source: "none".into(),
            model: None,
            context_tokens: 0,
            context_limit: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            cost_usd: None,
            turns: 0,
            tools: Vec::new(),
            files: Vec::new(),
            session_id: None,
            rss_mb: 0,
            cpu_percent: 0.0,
            uptime_secs: 0,
            pid: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextReport {
    pub panes: Vec<PaneContext>,
    pub total_mb: u64,
    pub available_mb: u64,
}

/// Kept across calls so sysinfo can compute CPU as a delta between two polls.
/// The first call therefore reports 0% for every pane, which is correct: there
/// is no prior sample to diff against.
fn system() -> &'static Mutex<System> {
    static SYS: OnceLock<Mutex<System>> = OnceLock::new();
    SYS.get_or_init(|| Mutex::new(System::new()))
}

#[tauri::command]
pub fn agent_context(
    store: State<'_, Arc<PtyStore>>,
    db: State<'_, StdMutex<Db>>,
    panes: Vec<PaneQuery>,
) -> Result<AgentContextReport, String> {
    let pids: std::collections::HashMap<String, u32> = store.session_pids().into_iter().collect();

    let mut sys = system().lock();
    sys.refresh_memory();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let (mem_by_pid, cpu_by_pid, children, start_by_pid) = process_maps(&sys);
    let total_mb = sys.total_memory() / MB;
    let available_mb = sys.available_memory() / MB;
    drop(sys);

    let now = now_seconds();
    let out = panes
        .into_iter()
        .map(|pane| {
            let session_id = db
                .lock()
                .ok()
                .and_then(|db| db.cli_session_id_for_pty(&pane.pty_id).ok().flatten());
            let mut ctx = transcript_context(&pane, session_id.as_deref())
                .unwrap_or_else(|| PaneContext::empty(pane.pty_id.clone()));
            if let Some(pid) = pids.get(&pane.pty_id).copied() {
                ctx.pid = Some(pid);
                ctx.rss_mb = tree_sum(pid, &mem_by_pid, &children) / MB;
                ctx.cpu_percent = tree_cpu(pid, &cpu_by_pid, &children);
                ctx.uptime_secs = start_by_pid
                    .get(&pid)
                    .map(|start| now.saturating_sub(*start))
                    .unwrap_or(0);
            }
            ctx
        })
        .collect();

    Ok(AgentContextReport {
        panes: out,
        total_mb,
        available_mb,
    })
}

type ProcMaps = (
    std::collections::HashMap<u32, u64>,
    std::collections::HashMap<u32, f32>,
    std::collections::HashMap<u32, Vec<u32>>,
    std::collections::HashMap<u32, u64>,
);

fn process_maps(sys: &System) -> ProcMaps {
    let (mem_by_pid, children) = tree_maps(sys);
    let mut cpu_by_pid = std::collections::HashMap::new();
    let mut start_by_pid = std::collections::HashMap::new();
    for (pid, process) in sys.processes() {
        if process.thread_kind().is_some() {
            continue;
        }
        cpu_by_pid.insert(pid.as_u32(), process.cpu_usage());
        start_by_pid.insert(pid.as_u32(), process.start_time());
    }
    (mem_by_pid, cpu_by_pid, children, start_by_pid)
}

fn tree_sum(
    root: u32,
    by_pid: &std::collections::HashMap<u32, u64>,
    children: &std::collections::HashMap<u32, Vec<u32>>,
) -> u64 {
    let mut total = 0u64;
    walk(root, children, &mut |pid| {
        total = total.saturating_add(by_pid.get(&pid).copied().unwrap_or(0));
    });
    total
}

fn tree_cpu(
    root: u32,
    by_pid: &std::collections::HashMap<u32, f32>,
    children: &std::collections::HashMap<u32, Vec<u32>>,
) -> f32 {
    let mut total = 0.0f32;
    walk(root, children, &mut |pid| {
        total += by_pid.get(&pid).copied().unwrap_or(0.0);
    });
    total
}

fn walk(
    root: u32,
    children: &std::collections::HashMap<u32, Vec<u32>>,
    visit: &mut impl FnMut(u32),
) {
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        visit(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
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

fn transcript_path(cwd: &str, session_id: Option<&str>) -> Option<PathBuf> {
    let dir = platform_command::user_home_dir()?
        .join(".claude")
        .join("projects")
        .join(cwd_slug(cwd));
    if let Some(id) = session_id {
        let direct = dir.join(format!("{id}.jsonl"));
        if direct.is_file() {
            return Some(direct);
        }
    }
    newest_jsonl(&dir)
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
        if best.as_ref().is_none_or(|(best, _)| modified > *best) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, path)| path)
}

/// Claude Code and Codex each keep a local transcript, in different layouts.
/// Any other CLI returns None so the caller falls back to a process-only row.
fn transcript_context(pane: &PaneQuery, session_id: Option<&str>) -> Option<PaneContext> {
    let cwd = pane.cwd.as_deref()?;
    let mut ctx = PaneContext::empty(pane.pty_id.clone());
    match pane.cli_id.as_deref()? {
        "claude" => {
            let path = transcript_path(cwd, session_id)?;
            parse_transcript(&path, &mut ctx)?;
            ctx.source = "claude".into();
            ctx.session_id = session_id.map(str::to_string).or_else(|| file_stem(&path));
            ctx.context_limit = context_limit_for(ctx.model.as_deref());
        }
        "codex" => {
            let path = codex_transcript_path(cwd)?;
            parse_codex_transcript(&path, &mut ctx)?;
            ctx.source = "codex".into();
            if ctx.context_limit == 0 {
                ctx.context_limit = DEFAULT_CONTEXT_LIMIT;
            }
        }
        _ => return None,
    }
    Some(ctx)
}

/// Codex stores rollouts under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
/// with the working directory recorded inside the file rather than in the path,
/// so the newest rollouts are scanned until one reports a matching cwd.
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

/// Reads the `session_meta` header line and returns the cwd it recorded.
fn codex_cwd(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok).take(8) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        return codex_meta_cwd(&event);
    }
    None
}

/// Codex has moved this field between releases, so accept the shapes seen in
/// the wild rather than binding to one.
fn codex_meta_cwd(event: &Value) -> Option<String> {
    for pointer in ["/payload/cwd", "/payload/workspace/cwd", "/cwd"] {
        if let Some(cwd) = event.pointer(pointer).and_then(Value::as_str) {
            return Some(cwd.to_string());
        }
    }
    None
}

fn parse_codex_transcript(path: &Path, ctx: &mut PaneContext) -> Option<()> {
    let file = File::open(path).ok()?;
    let mut budget = MAX_TRANSCRIPT_BYTES;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        budget = budget.saturating_sub(line.len() as u64 + 1);
        if budget == 0 {
            break;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        if event.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        if let Some(model) = event.pointer("/payload/info/model").and_then(Value::as_str) {
            ctx.model = Some(model.to_string());
        }
        if let Some(window) = event
            .pointer("/payload/info/model_context_window")
            .and_then(Value::as_u64)
        {
            ctx.context_limit = window;
        }
        let Some(last) = event.pointer("/payload/info/last_token_usage") else {
            continue;
        };
        ctx.turns += 1;
        apply_codex_usage(last, ctx);
    }
    Some(())
}

/// Codex reports `input_tokens` as the whole input and `cached_input_tokens`
/// as the cached subset, so the window occupancy is `input_tokens` as-is while
/// `input` here means the fresh part — matching how the usage panel splits it.
fn apply_codex_usage(usage: &Value, ctx: &mut PaneContext) {
    let total_input = as_u64(usage.get("input_tokens"));
    let cache_read = as_u64(usage.get("cached_input_tokens")).min(total_input);
    ctx.input_tokens = total_input.saturating_sub(cache_read);
    ctx.cache_read_tokens = cache_read;
    ctx.cache_write_tokens = as_u64(usage.get("cache_write_input_tokens"));
    ctx.output_tokens = as_u64(usage.get("output_tokens"));
    ctx.reasoning_tokens = as_u64(usage.get("reasoning_output_tokens"));
    ctx.context_tokens = total_input;
}

fn file_stem(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
}

/// Known context windows keyed by a substring of the model id. Anything
/// unrecognised falls back to 200k, the current Claude default.
fn context_limit_for(model: Option<&str>) -> u64 {
    let Some(model) = model else {
        return DEFAULT_CONTEXT_LIMIT;
    };
    const LIMITS: &[(&str, u64)] = &[
        ("haiku", 200_000),
        ("sonnet", 200_000),
        ("opus", 200_000),
        ("fable", 200_000),
    ];
    LIMITS
        .iter()
        .find(|(needle, _)| model.contains(needle))
        .map(|(_, limit)| *limit)
        .unwrap_or(DEFAULT_CONTEXT_LIMIT)
}

fn parse_transcript(path: &Path, ctx: &mut PaneContext) -> Option<()> {
    let file = File::open(path).ok()?;
    let mut tools: Vec<(String, u64)> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let mut budget = MAX_TRANSCRIPT_BYTES;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        budget = budget.saturating_sub(line.len() as u64 + 1);
        if budget == 0 {
            break;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                ctx.turns += 1;
                if let Some(model) = event.pointer("/message/model").and_then(Value::as_str) {
                    ctx.model = Some(model.to_string());
                }
                // Each assistant turn reports the full prompt it was given, so
                // the newest one — not the sum — is what the agent is holding.
                if let Some(usage) = event.pointer("/message/usage") {
                    apply_usage(usage, ctx);
                }
                collect_tools(&event, &mut tools, &mut files);
            }
            Some("cost-state") => {
                if let Some(cost) = event.get("totalCostUSD").and_then(Value::as_f64) {
                    ctx.cost_usd = Some(cost);
                }
            }
            _ => {}
        }
    }

    tools.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    tools.truncate(MAX_TOOLS);
    ctx.tools = tools
        .into_iter()
        .map(|(name, count)| ToolCount { name, count })
        .collect();
    // Newest touched files first.
    files.reverse();
    files.truncate(MAX_FILES);
    ctx.files = files;
    Some(())
}

fn apply_usage(usage: &Value, ctx: &mut PaneContext) {
    let input = as_u64(usage.get("input_tokens"));
    let cache_read = as_u64(usage.get("cache_read_input_tokens"));
    let cache_write = as_u64(usage.get("cache_creation_input_tokens"));
    ctx.input_tokens = input;
    ctx.cache_read_tokens = cache_read;
    ctx.cache_write_tokens = cache_write;
    ctx.output_tokens = as_u64(usage.get("output_tokens"));
    ctx.reasoning_tokens = as_u64(usage.pointer("/output_tokens_details/thinking_tokens"));
    // What actually occupies the window on the next turn: the prompt that was
    // just sent, whether it was cached or not.
    ctx.context_tokens = input.saturating_add(cache_read).saturating_add(cache_write);
}

fn as_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n.max(0) as u64)))
        .unwrap_or(0)
}

fn collect_tools(event: &Value, tools: &mut Vec<(String, u64)>, files: &mut Vec<String>) {
    let Some(blocks) = event.pointer("/message/content").and_then(Value::as_array) else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        if let Some(name) = block.get("name").and_then(Value::as_str) {
            match tools.iter_mut().find(|(known, _)| known == name) {
                Some((_, count)) => *count += 1,
                None => tools.push((name.to_string(), 1)),
            }
        }
        if let Some(path) = block.pointer("/input/file_path").and_then(Value::as_str) {
            let short = path.rsplit('/').next().unwrap_or(path).to_string();
            files.retain(|f| f != &short);
            files.push(short);
        }
    }
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
    fn context_limit_falls_back_for_unknown_models() {
        assert_eq!(context_limit_for(Some("claude-opus-5")), 200_000);
        assert_eq!(
            context_limit_for(Some("something-else")),
            DEFAULT_CONTEXT_LIMIT
        );
        assert_eq!(context_limit_for(None), DEFAULT_CONTEXT_LIMIT);
    }

    #[test]
    fn context_tokens_are_the_last_prompt_not_the_sum() {
        let mut ctx = PaneContext::empty("p".into());
        apply_usage(
            &serde_json::json!({
                "input_tokens": 32,
                "cache_read_input_tokens": 54_852,
                "cache_creation_input_tokens": 1_304,
                "output_tokens": 1_475,
                "output_tokens_details": { "thinking_tokens": 521 }
            }),
            &mut ctx,
        );
        assert_eq!(ctx.context_tokens, 32 + 54_852 + 1_304);
        assert_eq!(ctx.reasoning_tokens, 521);
        assert_eq!(ctx.output_tokens, 1_475);
    }

    #[test]
    fn tools_are_counted_and_files_deduped_newest_last() {
        let mut tools = Vec::new();
        let mut files = Vec::new();
        let event = serde_json::json!({
            "message": { "content": [
                { "type": "tool_use", "name": "Read", "input": { "file_path": "/a/one.ts" } },
                { "type": "tool_use", "name": "Read", "input": { "file_path": "/a/two.ts" } },
                { "type": "text", "text": "ignored" },
                { "type": "tool_use", "name": "Edit", "input": { "file_path": "/a/one.ts" } }
            ]}
        });
        collect_tools(&event, &mut tools, &mut files);
        assert_eq!(
            tools,
            vec![("Read".to_string(), 2), ("Edit".to_string(), 1)]
        );
        assert_eq!(files, vec!["two.ts".to_string(), "one.ts".to_string()]);
    }

    #[test]
    fn tree_sum_includes_descendants_and_survives_cycles() {
        let by_pid = [(1u32, 10u64), (2, 20), (3, 5)].into_iter().collect();
        let children = [(1u32, vec![2u32]), (2, vec![3, 1])].into_iter().collect();
        assert_eq!(tree_sum(1, &by_pid, &children), 35);
    }
}
