use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::platform_command;

mod claude_oauth;
mod codex_oauth;
mod time;
pub use claude_oauth::ClaudeAuthoritative;
use time::{as_u64, date_from_iso, unknown_date};

#[cfg(test)]
pub(crate) use time::iso_to_epoch_seconds;
#[cfg(not(test))]
use time::iso_to_epoch_seconds;

// Aggregates local token usage for Claude Code and Codex CLI by parsing the
// JSONL session files each CLI writes to disk.
//
// Sources:
//   - Claude Code: ~/.claude/projects/**/*.jsonl. Each assistant turn stores
//     `message.usage.{input,output,cache_creation_input,cache_read_input}_tokens`
//     with `message.id` and `message.model`. The same usage block often repeats
//     across consecutive assistant lines of the same request, so we dedup by
//     `message.id` per file to avoid double-counting.
//   - Codex CLI: ~/.codex/sessions/**/*.jsonl. Each turn emits
//     `type:"event_msg" payload:{type:"token_count", info:{last_token_usage},
//     rate_limits:{primary,secondary,plan_type,...}}`. `last_token_usage` is
//     per-turn (not cumulative); `rate_limits` is authoritative and comes
//     straight from OpenAI, so we surface the most recent one as-is.

const CLAUDE_BLOCK_SECONDS: i64 = 5 * 60 * 60;

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning: u64,
    pub total: u64,
}

impl TokenTotals {
    fn recompute_total(&mut self) {
        self.total = self
            .input
            .saturating_add(self.output)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write);
    }

    fn add(&mut self, other: &TokenTotals) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
        self.reasoning = self.reasoning.saturating_add(other.reasoning);
        self.recompute_total();
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DailyBucket {
    pub date: String,
    pub claude: TokenTotals,
    pub codex: TokenTotals,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTotals {
    pub claude: TokenTotals,
    pub codex: TokenTotals,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWarning {
    pub provider: String,
    pub message: String,
}

/// Rate-limit snapshot Codex received from OpenAI. Comes either from a live
/// fetch against Codex's backend usage endpoint or from the most recent
/// `event_msg`/`token_count` event across all Codex JSONL sessions.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimits {
    /// Server-reported plan name (e.g. "prolite", "plus", "pro"). Verbatim.
    pub plan_type: Option<String>,
    /// UTC timestamp (ISO 8601, seconds precision) of the snapshot's source
    /// event. Only present for JSONL snapshots; live fetches leave it unset.
    pub captured_at: Option<String>,
    pub primary: Option<CodexRateWindow>,
    pub secondary: Option<CodexRateWindow>,
    /// "live" when refreshed from the API, "snapshot" when read from JSONL.
    pub source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateWindow {
    pub used_percent: f64,
    /// Window duration Codex reports.
    pub window_minutes: Option<u64>,
    /// Unix epoch seconds when the window resets.
    pub resets_at: Option<i64>,
}

/// Rolling 5-hour Claude Code "billing block": tokens attributed to the
/// current block (first message in the last 5h) and the block boundaries.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeBlock {
    /// Unix epoch seconds of the first message of the active block.
    pub started_at: i64,
    /// Unix epoch seconds when the block expires (started_at + 5h).
    pub ends_at: i64,
    pub tokens: TokenTotals,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// Daily buckets, sorted newest first.
    pub daily: Vec<DailyBucket>,
    pub totals: ProviderTotals,
    pub warnings: Vec<UsageWarning>,
    /// Authoritative Codex rate limits from the newest JSONL event, if any.
    pub codex_limits: Option<CodexRateLimits>,
    /// Current 5-hour Claude Code block, if the CLI has been used in the
    /// last 5 hours.
    pub claude_block: Option<ClaudeBlock>,
    /// Authoritative Claude Code usage snapshot from the OAuth usage endpoint.
    /// Uses the same OAuth token Claude Code itself uses; `None` when the
    /// user isn't signed in locally or the request failed.
    pub claude_authoritative: Option<ClaudeAuthoritative>,
    /// Server-reported "now" seconds so the UI countdown stays aligned with
    /// the Rust timestamps we returned above.
    pub now_seconds: i64,
}

#[tauri::command]
pub async fn usage_summary() -> Result<UsageReport, String> {
    let claude_daily = tokio::task::spawn_blocking(collect_claude_from_default);
    let codex_daily = tokio::task::spawn_blocking(collect_codex_from_default);
    let claude_block = tokio::task::spawn_blocking(claude_block_from_default);
    let codex_limits = tokio::task::spawn_blocking(codex_limits_from_default);
    let claude_authoritative = claude_oauth::fetch();
    let codex_authoritative = codex_oauth::fetch();
    let (
        claude_daily,
        codex_daily,
        claude_block,
        codex_limits,
        claude_authoritative,
        codex_authoritative,
    ) = tokio::join!(
        claude_daily,
        codex_daily,
        claude_block,
        codex_limits,
        claude_authoritative,
        codex_authoritative
    );

    let mut merged: BTreeMap<String, DailyBucket> = BTreeMap::new();
    let mut totals = ProviderTotals::default();
    let mut warnings = Vec::new();

    match claude_daily.unwrap_or_else(|error| Err(format!("claude task failed: {error}"))) {
        Ok(days) => {
            for (date, tokens) in days {
                let bucket = merged.entry(date.clone()).or_insert_with(|| DailyBucket {
                    date,
                    claude: TokenTotals::default(),
                    codex: TokenTotals::default(),
                });
                bucket.claude.add(&tokens);
                totals.claude.add(&tokens);
            }
        }
        Err(message) => warnings.push(UsageWarning {
            provider: "claude".to_string(),
            message,
        }),
    }

    match codex_daily.unwrap_or_else(|error| Err(format!("codex task failed: {error}"))) {
        Ok(days) => {
            for (date, tokens) in days {
                let bucket = merged.entry(date.clone()).or_insert_with(|| DailyBucket {
                    date,
                    claude: TokenTotals::default(),
                    codex: TokenTotals::default(),
                });
                bucket.codex.add(&tokens);
                totals.codex.add(&tokens);
            }
        }
        Err(message) => warnings.push(UsageWarning {
            provider: "codex".to_string(),
            message,
        }),
    }

    let mut daily: Vec<DailyBucket> = merged.into_values().collect();
    // Newest first for the UI's "last N days" slice.
    daily.sort_by(|a, b| b.date.cmp(&a.date));

    let claude_block = match claude_block
        .unwrap_or_else(|error| Err(format!("claude block task failed: {error}")))
    {
        Ok(block) => block,
        Err(message) => {
            warnings.push(UsageWarning {
                provider: "claude".to_string(),
                message,
            });
            None
        }
    };
    let snapshot_limits = match codex_limits
        .unwrap_or_else(|error| Err(format!("codex limits task failed: {error}")))
    {
        Ok(limits) => limits,
        Err(message) => {
            warnings.push(UsageWarning {
                provider: "codex".to_string(),
                message,
            });
            None
        }
    };
    // Prefer the live authoritative fetch when available; the JSONL snapshot
    // is our fallback for offline / unsigned-in users. Warnings from the
    // live path are surfaced so a broken auth can be diagnosed.
    let live_limits = match codex_authoritative {
        Ok(Some(live)) => Some(codex_oauth::as_rate_limits(&live)),
        Ok(None) => None,
        Err(message) => {
            warnings.push(UsageWarning {
                provider: "codex".to_string(),
                message,
            });
            None
        }
    };
    let codex_limits = live_limits.or(snapshot_limits);
    let claude_authoritative = match claude_authoritative {
        Ok(value) => value,
        Err(message) => {
            warnings.push(UsageWarning {
                provider: "claude".to_string(),
                message,
            });
            None
        }
    };

    Ok(UsageReport {
        daily,
        totals,
        warnings,
        codex_limits,
        claude_block,
        claude_authoritative,
        now_seconds: now_seconds(),
    })
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn home_dir() -> Result<PathBuf, String> {
    platform_command::user_home_dir()
        .ok_or_else(|| "user home directory is unavailable".to_string())
}

fn collect_claude_from_default() -> Result<BTreeMap<String, TokenTotals>, String> {
    let root = home_dir()?.join(".claude/projects");
    collect_claude_from_dir(&root)
}

pub(crate) fn collect_claude_from_dir(
    root: &Path,
) -> Result<BTreeMap<String, TokenTotals>, String> {
    if !root.exists() {
        // Absence of the store is fine: the CLI may not be installed yet.
        return Ok(BTreeMap::new());
    }
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files)?;
    let mut days: BTreeMap<String, TokenTotals> = BTreeMap::new();
    for path in files {
        parse_claude_file(&path, &mut days);
    }
    Ok(days)
}

fn collect_codex_from_default() -> Result<BTreeMap<String, TokenTotals>, String> {
    let root = home_dir()?.join(".codex/sessions");
    collect_codex_from_dir(&root)
}

pub(crate) fn collect_codex_from_dir(root: &Path) -> Result<BTreeMap<String, TokenTotals>, String> {
    if !root.exists() {
        return Ok(BTreeMap::new());
    }
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files)?;
    let mut days: BTreeMap<String, TokenTotals> = BTreeMap::new();
    for path in files {
        parse_codex_file(&path, &mut days);
    }
    Ok(days)
}

fn claude_block_from_default() -> Result<Option<ClaudeBlock>, String> {
    let root = home_dir()?.join(".claude/projects");
    claude_block_from_dir(&root, now_seconds())
}

pub(crate) fn claude_block_from_dir(root: &Path, now: i64) -> Result<Option<ClaudeBlock>, String> {
    if !root.exists() {
        return Ok(None);
    }
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files)?;
    let cutoff = now - CLAUDE_BLOCK_SECONDS;
    // Two parallel streams: `activity` covers ANY timestamped line so we can
    // pin the block start to the same instant Claude Code itself uses
    // (the first user message of the session, not the first assistant reply).
    // `usage_events` is the subset that carried token counters.
    let mut activity: Vec<i64> = Vec::new();
    let mut usage_events: Vec<(i64, TokenTotals)> = Vec::new();
    for path in files {
        collect_claude_events(&path, cutoff, &mut activity, &mut usage_events);
    }
    if activity.is_empty() {
        return Ok(None);
    }
    activity.sort_unstable();
    let Some(started_at) = activity
        .into_iter()
        .find(|ts| *ts + CLAUDE_BLOCK_SECONDS > now)
    else {
        return Ok(None);
    };
    let end = started_at + CLAUDE_BLOCK_SECONDS;
    let mut tokens = TokenTotals::default();
    for (ts, ev_tokens) in usage_events {
        if ts >= started_at && ts < end {
            tokens.add(&ev_tokens);
        }
    }
    Ok(Some(ClaudeBlock {
        started_at,
        ends_at: end,
        tokens,
    }))
}

fn codex_limits_from_default() -> Result<Option<CodexRateLimits>, String> {
    let root = home_dir()?.join(".codex/sessions");
    codex_limits_from_dir(&root)
}

pub(crate) fn codex_limits_from_dir(root: &Path) -> Result<Option<CodexRateLimits>, String> {
    if !root.exists() {
        return Ok(None);
    }
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files)?;
    // Sort by mtime desc so we scan the newest sessions first and stop at the
    // first rate_limits payload we find.
    let mut with_mtime: Vec<(PathBuf, SystemTime)> = files
        .into_iter()
        .filter_map(|p| {
            let modified = std::fs::metadata(&p).and_then(|m| m.modified()).ok()?;
            Some((p, modified))
        })
        .collect();
    with_mtime.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    for (path, _) in with_mtime {
        if let Some(limits) = codex_limits_from_file(&path) {
            return Ok(Some(limits));
        }
    }
    Ok(None)
}

fn codex_limits_from_file(path: &Path) -> Option<CodexRateLimits> {
    let file = File::open(path).ok()?;
    // Keep the LAST rate_limits seen in the file: sessions may report the
    // snapshot several times as usage progresses.
    let mut best: Option<(String, CodexRateLimits)> = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(payload) = event.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(rate_limits) = payload.get("rate_limits") else {
            continue;
        };
        let ts = event
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let limits = CodexRateLimits {
            plan_type: rate_limits
                .get("plan_type")
                .and_then(Value::as_str)
                .map(str::to_string),
            captured_at: (!ts.is_empty()).then(|| ts.clone()),
            primary: parse_codex_window(rate_limits.get("primary")),
            secondary: parse_codex_window(rate_limits.get("secondary")),
            source: "snapshot".to_string(),
        };
        match &best {
            None => best = Some((ts, limits)),
            Some((prev_ts, _)) if ts >= *prev_ts => best = Some((ts, limits)),
            _ => {}
        }
    }
    best.map(|(_, limits)| limits)
}

fn parse_codex_window(value: Option<&Value>) -> Option<CodexRateWindow> {
    let window = value?;
    if window.is_null() {
        return None;
    }
    let used_percent = window.get("used_percent").and_then(Value::as_f64)?;
    Some(CodexRateWindow {
        used_percent,
        window_minutes: window.get("window_minutes").and_then(Value::as_u64),
        resets_at: window.get("resets_at").and_then(Value::as_i64),
    })
}

fn collect_jsonl_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| format!("could not read {}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("could not read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("could not inspect {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_jsonl_files(&entry.path(), files)?;
        } else if entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn parse_claude_file(path: &Path, days: &mut BTreeMap<String, TokenTotals>) {
    let Ok(file) = File::open(path) else {
        return;
    };
    // Message ids often repeat across consecutive assistant lines of the same
    // request. Dedup per-file so we count each request once.
    let mut seen: HashSet<String> = HashSet::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(usage) = event.pointer("/message/usage") else {
            continue;
        };
        if let Some(id) = event
            .pointer("/message/id")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            if !seen.insert(id) {
                continue;
            }
        }
        let date = event
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(date_from_iso)
            .unwrap_or_else(unknown_date);
        let tokens = claude_usage_tokens(usage);
        days.entry(date).or_default().add(&tokens);
    }
}

fn collect_claude_events(
    path: &Path,
    cutoff_seconds: i64,
    activity: &mut Vec<i64>,
    usage_events: &mut Vec<(i64, TokenTotals)>,
) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut seen: HashSet<String> = HashSet::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(ts) = event
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(iso_to_epoch_seconds)
        else {
            continue;
        };
        if ts < cutoff_seconds {
            continue;
        }
        // Any timestamped event counts as activity for pinning block start:
        // Claude Code's 5-hour session starts when the user sends the first
        // message of the session, not when the model first replies.
        activity.push(ts);
        let Some(usage) = event.pointer("/message/usage") else {
            continue;
        };
        if let Some(id) = event
            .pointer("/message/id")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            if !seen.insert(id) {
                continue;
            }
        }
        usage_events.push((ts, claude_usage_tokens(usage)));
    }
}

fn claude_usage_tokens(usage: &Value) -> TokenTotals {
    let input = as_u64(usage.get("input_tokens"));
    let output = as_u64(usage.get("output_tokens"));
    let cache_read = as_u64(usage.get("cache_read_input_tokens"));
    let cache_write = as_u64(usage.get("cache_creation_input_tokens"));
    let reasoning = as_u64(usage.pointer("/output_tokens_details/thinking_tokens"));
    let mut tokens = TokenTotals {
        input,
        output,
        cache_read,
        cache_write,
        reasoning,
        total: 0,
    };
    tokens.recompute_total();
    tokens
}

fn parse_codex_file(path: &Path, days: &mut BTreeMap<String, TokenTotals>) {
    let Ok(file) = File::open(path) else {
        return;
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
        let Some(last) = event.pointer("/payload/info/last_token_usage") else {
            continue;
        };
        let date = event
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(date_from_iso)
            .unwrap_or_else(unknown_date);
        let tokens = codex_last_usage_tokens(last);
        days.entry(date).or_default().add(&tokens);
    }
}

fn codex_last_usage_tokens(usage: &Value) -> TokenTotals {
    // Codex reports `input_tokens` as the full input (cached + fresh) and
    // `cached_input_tokens` as the cached subset. Split them so `input` here
    // means fresh input only, matching how Claude reports it.
    let total_input = as_u64(usage.get("input_tokens"));
    let cache_read = as_u64(usage.get("cached_input_tokens")).min(total_input);
    let input = total_input.saturating_sub(cache_read);
    let cache_write = as_u64(usage.get("cache_write_input_tokens"));
    let output = as_u64(usage.get("output_tokens"));
    let reasoning = as_u64(usage.get("reasoning_output_tokens"));
    let mut tokens = TokenTotals {
        input,
        output,
        cache_read,
        cache_write,
        reasoning,
        total: 0,
    };
    tokens.recompute_total();
    tokens
}

#[cfg(test)]
mod tests;
