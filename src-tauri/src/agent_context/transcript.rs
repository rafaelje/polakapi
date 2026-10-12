use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

// Turns a Claude Code transcript into something a human can read: the ordered
// content the model was given, classified so the window can show both what
// occupies the window and the text itself.
//
// Token figures here are estimates from character counts. The authoritative
// number is the `usage` block of the newest assistant turn, which the caller
// reports separately; the per-entry split cannot come from the API because
// usage is reported per request, not per content block.
//
// One walk produces both the listing (previews) and the full bodies, kept in
// parallel vectors so an entry id is an index into both. Deriving the bodies in
// a second pass would desynchronise the moment one pass skipped a block.

const CHARS_PER_TOKEN: usize = 4;
const PREVIEW_CHARS: usize = 400;
/// Guards the window against a single pathological entry (a multi-MB file read)
/// when the user asks for the full body.
const MAX_BODY_CHARS: usize = 400_000;
/// Enough context around a hit to judge it without opening the entry.
const SNIPPET_PAD: usize = 80;
const MAX_MATCHES_PER_ENTRY: usize = 200;
/// Caps the compiled program so a pathological pattern cannot exhaust memory.
const REGEX_SIZE_LIMIT: usize = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntryKind {
    /// Injected instructions: system reminders, memory, skill and file attachments.
    Instructions,
    UserPrompt,
    AssistantText,
    Thinking,
    ToolCall,
    /// Result of a tool call that read source material into the context.
    FileContent,
    ToolOutput,
}

impl EntryKind {
    fn bucket(self) -> &'static str {
        match self {
            EntryKind::Instructions => "instructions",
            EntryKind::UserPrompt | EntryKind::AssistantText => "messages",
            EntryKind::Thinking => "thinking",
            EntryKind::ToolCall | EntryKind::ToolOutput => "toolOutput",
            EntryKind::FileContent => "files",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEntry {
    /// Stable index into the parsed stream, used to fetch the full body later.
    pub id: usize,
    pub kind: EntryKind,
    /// Short human label: "Read", "user", "assistant".
    pub label: String,
    /// Secondary detail: a file name, a command, a tool argument.
    pub detail: Option<String>,
    pub timestamp: Option<String>,
    pub chars: usize,
    pub est_tokens: u64,
    pub preview: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    pub instructions: u64,
    pub files: u64,
    pub tool_output: u64,
    pub messages: u64,
    pub thinking: u64,
}

impl ContextBreakdown {
    fn add(&mut self, kind: EntryKind, tokens: u64) {
        let slot = match kind.bucket() {
            "instructions" => &mut self.instructions,
            "files" => &mut self.files,
            "toolOutput" => &mut self.tool_output,
            "thinking" => &mut self.thinking,
            _ => &mut self.messages,
        };
        *slot = slot.saturating_add(tokens);
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTranscript {
    pub entries: Vec<ContextEntry>,
    pub breakdown: ContextBreakdown,
    pub model: Option<String>,
}

#[derive(Default)]
struct Walk {
    parsed: ParsedTranscript,
    bodies: Vec<String>,
    tool_names: HashMap<String, String>,
}

/// Tools whose result is source material rather than a side effect, so their
/// output is attributed to "files" instead of generic tool output.
fn is_source_tool(name: &str) -> bool {
    matches!(
        name,
        "Read" | "Glob" | "Grep" | "NotebookRead" | "Edit" | "Write"
    )
}

pub fn parse(path: &Path) -> Option<ParsedTranscript> {
    walk(path).map(|w| w.parsed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub entry_id: usize,
    pub matches: u64,
    /// Text around the first match, newlines flattened so it fits one line.
    pub snippet: String,
}

/// Regex search over the **full** bodies, not the previews the listing carries.
///
/// Smart case, like ripgrep: a pattern written entirely in lower case matches
/// case-insensitively, and any upper-case character makes it case-sensitive.
/// Callers that want explicit control can still write `(?i)` themselves.
pub fn search(path: &Path, pattern: &str) -> Result<Vec<SearchHit>, String> {
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    let smart_case = !pattern.chars().any(char::is_uppercase);
    let re = regex::RegexBuilder::new(pattern)
        .case_insensitive(smart_case)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|error| format!("invalid regex: {error}"))?;
    let walked = walk(path).ok_or_else(|| format!("could not read {}", path.display()))?;

    let mut hits = Vec::new();
    for (entry_id, body) in walked.bodies.iter().enumerate() {
        let mut matches = 0u64;
        let mut snippet = None;
        for found in re.find_iter(body).take(MAX_MATCHES_PER_ENTRY) {
            matches += 1;
            if snippet.is_none() {
                snippet = Some(snippet_around(body, found.start(), found.end()));
            }
        }
        if matches > 0 {
            hits.push(SearchHit {
                entry_id,
                matches,
                snippet: snippet.unwrap_or_default(),
            });
        }
    }
    Ok(hits)
}

/// Widens a match to a readable window without splitting a UTF-8 code point.
fn snippet_around(body: &str, start: usize, end: usize) -> String {
    let mut from = start.saturating_sub(SNIPPET_PAD);
    while from > 0 && !body.is_char_boundary(from) {
        from -= 1;
    }
    let mut to = (end + SNIPPET_PAD).min(body.len());
    while to < body.len() && !body.is_char_boundary(to) {
        to += 1;
    }
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    out.push_str(body[from..to].trim());
    if to < body.len() {
        out.push('…');
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Full text of one entry. Re-walks the file so the listing payload never has
/// to carry every body to the webview.
pub fn entry_body(path: &Path, entry_id: usize) -> Option<String> {
    let mut walked = walk(path)?;
    if entry_id >= walked.bodies.len() {
        return None;
    }
    let body = std::mem::take(&mut walked.bodies[entry_id]);
    Some(take_chars(&body, MAX_BODY_CHARS))
}

fn walk(path: &Path) -> Option<Walk> {
    let mut w = Walk::default();
    let file = File::open(path).ok()?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let ts = event
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        match event.get("type").and_then(Value::as_str) {
            Some("user") => read_message(&event, &ts, true, &mut w),
            Some("assistant") => {
                if let Some(model) = event.pointer("/message/model").and_then(Value::as_str) {
                    w.parsed.model = Some(model.to_string());
                }
                read_message(&event, &ts, false, &mut w);
            }
            Some("attachment") => {
                let text = compact_json(event.get("attachment"));
                push(
                    &mut w,
                    EntryKind::Instructions,
                    "attachment",
                    None,
                    &ts,
                    text,
                );
            }
            _ => {}
        }
    }
    Some(w)
}

fn read_message(event: &Value, ts: &Option<String>, from_user: bool, w: &mut Walk) {
    let Some(content) = event.pointer("/message/content") else {
        return;
    };
    if let Some(text) = content.as_str() {
        push_text(w, ts, from_user, text);
        return;
    }
    let Some(blocks) = content.as_array() else {
        return;
    };
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => push_text(w, ts, from_user, block_text(block)),
            Some("thinking") => {
                let text = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                push(w, EntryKind::Thinking, "thinking", None, ts, text);
            }
            Some("tool_use") => {
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                if let Some(id) = block.get("id").and_then(Value::as_str) {
                    w.tool_names.insert(id.to_string(), name.clone());
                }
                let detail = tool_detail(block);
                let body = compact_json(block.get("input"));
                push(w, EntryKind::ToolCall, &name, detail, ts, body);
            }
            Some("tool_result") => {
                let tool = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .and_then(|id| w.tool_names.get(id).cloned())
                    .unwrap_or_else(|| "tool".to_string());
                let kind = if is_source_tool(&tool) {
                    EntryKind::FileContent
                } else {
                    EntryKind::ToolOutput
                };
                let body = block.get("content").map(result_text).unwrap_or_default();
                push(w, kind, &format!("{tool} result"), None, ts, body);
            }
            _ => {}
        }
    }
}

/// A tool result is either a plain string or a list of content blocks.
fn result_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(blocks) = content.as_array() {
        let joined: Vec<String> = blocks
            .iter()
            .map(|block| match block.get("text").and_then(Value::as_str) {
                Some(text) => text.to_string(),
                None => compact_json(Some(block)),
            })
            .collect();
        return joined.join("\n");
    }
    compact_json(Some(content))
}

fn block_text(block: &Value) -> &str {
    block
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// A user turn carrying `<system-reminder>` is injected context (memory, rules,
/// hook output), not something the human typed.
fn push_text(w: &mut Walk, ts: &Option<String>, from_user: bool, text: &str) {
    if text.is_empty() {
        return;
    }
    let (kind, label) = if from_user {
        if text.contains("<system-reminder>") {
            (EntryKind::Instructions, "injected context")
        } else {
            (EntryKind::UserPrompt, "user")
        }
    } else {
        (EntryKind::AssistantText, "assistant")
    };
    push(w, kind, label, None, ts, text.to_string());
}

fn tool_detail(block: &Value) -> Option<String> {
    for pointer in [
        "/input/file_path",
        "/input/command",
        "/input/pattern",
        "/input/path",
    ] {
        if let Some(value) = block.pointer(pointer).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(first_line(trimmed, 120));
            }
        }
    }
    None
}

fn compact_json(value: Option<&Value>) -> String {
    value
        .map(|v| match v.as_str() {
            Some(text) => text.to_string(),
            None => serde_json::to_string_pretty(v).unwrap_or_default(),
        })
        .unwrap_or_default()
}

fn first_line(text: &str, max: usize) -> String {
    take_chars(text.lines().next().unwrap_or(""), max)
}

fn take_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

fn push(
    w: &mut Walk,
    kind: EntryKind,
    label: &str,
    detail: Option<String>,
    ts: &Option<String>,
    body: String,
) {
    if body.is_empty() {
        return;
    }
    let chars = body.chars().count();
    let est_tokens = (chars / CHARS_PER_TOKEN) as u64;
    w.parsed.breakdown.add(kind, est_tokens);
    w.parsed.entries.push(ContextEntry {
        id: w.parsed.entries.len(),
        kind,
        label: label.to_string(),
        detail,
        timestamp: ts.clone(),
        chars,
        est_tokens,
        preview: take_chars(&body, PREVIEW_CHARS),
        truncated: chars > PREVIEW_CHARS,
    });
    w.bodies.push(body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn transcript(lines: &[Value]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        file.flush().unwrap();
        file
    }

    #[test]
    fn classifies_injected_context_apart_from_the_human_prompt() {
        let file = transcript(&[
            serde_json::json!({
                "type": "user",
                "message": { "content": [
                    { "type": "text", "text": "<system-reminder>rules</system-reminder>" }
                ]}
            }),
            serde_json::json!({
                "type": "user",
                "message": { "content": [{ "type": "text", "text": "fix the panel" }] }
            }),
        ]);
        let parsed = parse(file.path()).unwrap();
        assert_eq!(parsed.entries[0].kind, EntryKind::Instructions);
        assert_eq!(parsed.entries[1].kind, EntryKind::UserPrompt);
    }

    #[test]
    fn attributes_read_results_to_files_and_bash_results_to_tool_output() {
        let file = transcript(&[
            serde_json::json!({
                "type": "assistant",
                "message": { "model": "claude-opus-5", "content": [
                    { "type": "tool_use", "id": "t1", "name": "Read",
                      "input": { "file_path": "/a/x.ts" } },
                    { "type": "tool_use", "id": "t2", "name": "Bash",
                      "input": { "command": "cargo test" } }
                ]}
            }),
            serde_json::json!({
                "type": "user",
                "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "file body" },
                    { "type": "tool_result", "tool_use_id": "t2", "content": "test output" }
                ]}
            }),
        ]);
        let parsed = parse(file.path()).unwrap();
        let kinds: Vec<_> = parsed.entries.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                EntryKind::ToolCall,
                EntryKind::ToolCall,
                EntryKind::FileContent,
                EntryKind::ToolOutput
            ]
        );
        assert_eq!(parsed.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(parsed.entries[0].detail.as_deref(), Some("/a/x.ts"));
        assert_eq!(parsed.entries[1].detail.as_deref(), Some("cargo test"));
    }

    #[test]
    fn reads_tool_results_delivered_as_content_blocks() {
        let file = transcript(&[serde_json::json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t9",
                  "content": [{ "type": "text", "text": "block form" }] }
            ]}
        })]);
        let parsed = parse(file.path()).unwrap();
        assert_eq!(parsed.entries[0].preview, "block form");
    }

    #[test]
    fn previews_are_capped_and_flagged() {
        let long = "x".repeat(PREVIEW_CHARS + 50);
        let file = transcript(&[serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "text", "text": long }] }
        })]);
        let parsed = parse(file.path()).unwrap();
        assert!(parsed.entries[0].truncated);
        assert_eq!(parsed.entries[0].preview.chars().count(), PREVIEW_CHARS);
        assert_eq!(parsed.entries[0].chars, PREVIEW_CHARS + 50);
    }

    #[test]
    fn entry_body_returns_the_full_text_and_ids_line_up() {
        let long = "y".repeat(PREVIEW_CHARS + 20);
        let file = transcript(&[
            serde_json::json!({
                "type": "user",
                "message": { "content": [{ "type": "text", "text": "first" }] }
            }),
            serde_json::json!({
                "type": "user",
                "message": { "content": [{ "type": "text", "text": long }] }
            }),
        ]);
        assert_eq!(entry_body(file.path(), 0).unwrap(), "first");
        assert_eq!(
            entry_body(file.path(), 1).unwrap().chars().count(),
            long.chars().count()
        );
        assert!(entry_body(file.path(), 2).is_none());
    }

    #[test]
    fn search_matches_past_the_preview_cut() {
        let buried = format!("{}NEEDLE tail", "z".repeat(PREVIEW_CHARS * 2));
        let file = transcript(&[serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "text", "text": buried }] }
        })]);
        let hits = search(file.path(), "NEEDLE").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry_id, 0);
        assert_eq!(hits[0].matches, 1);
        assert!(hits[0].snippet.contains("NEEDLE"));
        // Truncated on both sides, so the snippet is not the whole body.
        assert!(hits[0].snippet.starts_with('…'));
    }

    #[test]
    fn search_is_smart_case() {
        let file = transcript(&[serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "text", "text": "Cargo Clippy" }] }
        })]);
        // All-lowercase pattern ignores case...
        assert_eq!(search(file.path(), "cargo").unwrap().len(), 1);
        // ...but an upper-case character makes it exact.
        assert_eq!(search(file.path(), "CARGO").unwrap().len(), 0);
        assert_eq!(search(file.path(), "Cargo").unwrap().len(), 1);
    }

    #[test]
    fn search_counts_every_match_and_supports_patterns() {
        let file = transcript(&[serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "text", "text": "a1 b2 c3" }] }
        })]);
        assert_eq!(search(file.path(), r"[a-c]\d").unwrap()[0].matches, 3);
    }

    #[test]
    fn search_rejects_an_invalid_pattern_instead_of_panicking() {
        let file = transcript(&[serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "text", "text": "x" }] }
        })]);
        let error = search(file.path(), "(unclosed").unwrap_err();
        assert!(error.contains("invalid regex"), "{error}");
    }

    #[test]
    fn empty_pattern_matches_nothing_rather_than_everything() {
        let file = transcript(&[serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "text", "text": "anything" }] }
        })]);
        assert!(search(file.path(), "").unwrap().is_empty());
    }

    #[test]
    fn snippets_never_split_a_code_point() {
        let body = "áéí NEEDLE óú";
        let start = body.find("NEEDLE").unwrap();
        let snippet = snippet_around(body, start, start + "NEEDLE".len());
        assert!(snippet.contains("NEEDLE"));
        assert!(snippet.contains('á'));
    }

    #[test]
    fn breakdown_routes_each_kind_to_its_bucket() {
        let mut breakdown = ContextBreakdown::default();
        breakdown.add(EntryKind::Instructions, 10);
        breakdown.add(EntryKind::FileContent, 20);
        breakdown.add(EntryKind::ToolOutput, 5);
        breakdown.add(EntryKind::ToolCall, 1);
        breakdown.add(EntryKind::UserPrompt, 3);
        breakdown.add(EntryKind::AssistantText, 4);
        breakdown.add(EntryKind::Thinking, 2);
        assert_eq!(breakdown.instructions, 10);
        assert_eq!(breakdown.files, 20);
        // Tool calls and their output share one bucket.
        assert_eq!(breakdown.tool_output, 6);
        assert_eq!(breakdown.messages, 7);
        assert_eq!(breakdown.thinking, 2);
    }
}
