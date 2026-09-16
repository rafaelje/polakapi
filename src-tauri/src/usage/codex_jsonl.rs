use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::time::{as_u64, date_from_iso, unknown_date};
use super::{collect_jsonl_files, home_dir, CodexRateLimits, CodexRateWindow, TokenTotals};

// Codex CLI JSONL parsing: per-turn token counts for the daily buckets and
// the newest authoritative `rate_limits` snapshot. See the module doc in
// `usage.rs` for the event shapes.

pub(super) fn collect_codex_from_default() -> Result<BTreeMap<String, TokenTotals>, String> {
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

pub(super) fn codex_limits_from_default() -> Result<Option<CodexRateLimits>, String> {
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
