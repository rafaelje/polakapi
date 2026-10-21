use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::agent_context::cwd_slug;
use crate::platform_command;

// The agent tab's CLI writes each turn to a JSONL transcript. Before a
// dictation is typed in, every candidate file's length is noted; afterwards
// only what was appended is read, until the turn that holds the dictation
// ends.

const POLL: Duration = Duration::from_millis(700);
const NEEDLE_CHARS: usize = 80;
/// Codex keeps `sessions/YYYY/MM/DD`; the newest two of each cover a turn
/// that crosses midnight or the end of a month.
const CODEX_RECENT_DIRS: usize = 2;

pub struct Watch {
    cli: String,
    root: PathBuf,
    files: HashMap<PathBuf, File>,
}

#[derive(Default)]
struct File {
    offset: u64,
    matched: bool,
    last_text: Option<String>,
}

enum Step {
    Pending,
    Done(Option<String>),
    Aborted,
}

impl Watch {
    pub fn start(cli: &str, agent_home: &Path) -> Result<Self, String> {
        let user_home =
            platform_command::user_home_dir().ok_or("no home directory to find transcripts in")?;
        let root = match cli {
            "claude" => user_home
                .join(".claude")
                .join("projects")
                .join(cwd_slug(&agent_home.to_string_lossy())),
            "codex" => user_home.join(".codex").join("sessions"),
            other => return Err(format!("answers from {other} cannot be read aloud")),
        };
        let mut watch = Self {
            cli: cli.to_string(),
            root,
            files: HashMap::new(),
        };
        for path in watch.candidates() {
            let offset = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            watch.files.insert(
                path,
                File {
                    offset,
                    ..File::default()
                },
            );
        }
        Ok(watch)
    }

    pub async fn reply(
        mut self,
        prompt: &str,
        timeout: Duration,
    ) -> Result<Option<String>, String> {
        let needle: String = normalize(prompt).chars().take(NEEDLE_CHARS).collect();
        if needle.is_empty() {
            return Ok(None);
        }
        let deadline = Instant::now() + timeout;
        loop {
            for path in self.candidates() {
                let file = self.files.entry(path.clone()).or_default();
                match read_new(&path, file, &self.cli, &needle) {
                    Step::Pending => {}
                    Step::Done(text) => return Ok(text),
                    Step::Aborted => return Err("the agent stopped before answering".to_string()),
                }
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "the agent did not finish within {}s",
                    timeout.as_secs()
                ));
            }
            tokio::time::sleep(POLL).await;
        }
    }

    fn candidates(&self) -> Vec<PathBuf> {
        if self.cli == "claude" {
            return jsonl_in(&self.root);
        }
        let mut dirs = vec![self.root.clone()];
        for _ in 0..3 {
            dirs = dirs
                .iter()
                .flat_map(|dir| newest_dirs(dir, CODEX_RECENT_DIRS))
                .collect();
        }
        dirs.iter().flat_map(|dir| jsonl_in(dir)).collect()
    }
}

fn jsonl_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect()
}

fn newest_dirs(dir: &Path, count: usize) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs.into_iter().rev().take(count).collect()
}

/// Reads the complete lines appended since the last call.
fn read_new(path: &Path, file: &mut File, cli: &str, needle: &str) -> Step {
    let Ok(mut handle) = std::fs::File::open(path) else {
        return Step::Pending;
    };
    let len = handle.metadata().map(|meta| meta.len()).unwrap_or(0);
    if len < file.offset {
        file.offset = 0;
    }
    if len == file.offset || handle.seek(SeekFrom::Start(file.offset)).is_err() {
        return Step::Pending;
    }
    let mut bytes = Vec::new();
    if handle.read_to_end(&mut bytes).is_err() {
        return Step::Pending;
    }
    let Some(end) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return Step::Pending;
    };
    file.offset += end as u64 + 1;
    for line in bytes[..end].split(|byte| *byte == b'\n') {
        let Ok(entry) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let step = match cli {
            "claude" => claude_entry(&entry, file, needle),
            _ => codex_entry(&entry, file, needle),
        };
        if !matches!(step, Step::Pending) {
            return step;
        }
    }
    Step::Pending
}

fn claude_entry(entry: &Value, file: &mut File, needle: &str) -> Step {
    let message = entry.get("message");
    match entry.get("type").and_then(Value::as_str) {
        Some("user") if !file.matched => {
            if let Some(content) = message.and_then(|message| message.get("content")) {
                if normalize(&content_text(content, "text")).contains(needle) {
                    file.matched = true;
                }
            }
            Step::Pending
        }
        Some("assistant") if file.matched => {
            let Some(message) = message else {
                return Step::Pending;
            };
            if let Some(content) = message.get("content") {
                let text = content_text(content, "text");
                if !text.trim().is_empty() {
                    file.last_text = Some(text);
                }
            }
            match message.get("stop_reason").and_then(Value::as_str) {
                Some("end_turn" | "stop_sequence") => Step::Done(file.last_text.take()),
                _ => Step::Pending,
            }
        }
        _ => Step::Pending,
    }
}

fn codex_entry(entry: &Value, file: &mut File, needle: &str) -> Step {
    let Some(payload) = entry.get("payload") else {
        return Step::Pending;
    };
    match payload.get("type").and_then(Value::as_str) {
        Some("user_message") if !file.matched => {
            let text = payload.get("message").and_then(Value::as_str).unwrap_or("");
            file.matched = normalize(text).contains(needle);
            Step::Pending
        }
        Some("message") if !file.matched => {
            if payload.get("role").and_then(Value::as_str) == Some("user") {
                if let Some(content) = payload.get("content") {
                    file.matched = normalize(&content_text(content, "input_text")).contains(needle);
                }
            }
            Step::Pending
        }
        Some("agent_message") if file.matched => {
            if let Some(text) = payload.get("message").and_then(Value::as_str) {
                file.last_text = Some(text.to_string());
            }
            Step::Pending
        }
        Some("task_complete") if file.matched => {
            let text = payload
                .get("last_agent_message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| file.last_text.take());
            Step::Done(text)
        }
        Some("turn_aborted") if file.matched => Step::Aborted,
        _ => Step::Pending,
    }
}

/// A message's text: a plain string, or its blocks of type `kind` joined.
fn content_text(content: &Value, kind: &str) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some(kind))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn append(path: &Path, lines: &[Value]) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    #[test]
    fn claude_answer_after_the_dictation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(
            &path,
            &[serde_json::json!({"type":"user","message":{"content":"[voice] open polakapi"}})],
        );
        let mut file = File {
            offset: std::fs::metadata(&path).unwrap().len(),
            ..File::default()
        };
        let needle = normalize("[voice] Open  polakapi");
        assert!(matches!(
            read_new(&path, &mut file, "claude", &needle),
            Step::Pending
        ));
        assert!(!file.matched, "lines before the mark are skipped");
        append(
            &path,
            &[
                serde_json::json!({"type":"user","message":{"content":[{"type":"text","text":"[voice] open polakapi"}]}}),
                serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"Opening it."}],"stop_reason":"tool_use"}}),
                serde_json::json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"…"}],"stop_reason":"end_turn"}}),
            ],
        );
        match read_new(&path, &mut file, "claude", &needle) {
            Step::Done(text) => assert_eq!(text.as_deref(), Some("Opening it.")),
            _ => panic!("the turn ended"),
        }
    }

    #[test]
    fn codex_answer_from_task_complete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        append(
            &path,
            &[
                serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"[voice] list projects"}}),
                serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Two projects."}}),
            ],
        );
        let mut file = File::default();
        match read_new(
            &path,
            &mut file,
            "codex",
            &normalize("[voice] list projects"),
        ) {
            Step::Done(text) => assert_eq!(text.as_deref(), Some("Two projects.")),
            _ => panic!("the turn ended"),
        }
    }

    #[test]
    fn partial_lines_wait_for_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, "{\"type\":\"user\"").unwrap();
        let mut file = File::default();
        assert!(matches!(
            read_new(&path, &mut file, "claude", "x"),
            Step::Pending
        ));
        assert_eq!(file.offset, 0);
    }
}
