//! Bounded, read-only access to one explicitly authorized Codex session.
//!
//! The SQLite thread index is the only locator. This module never searches the
//! sessions tree, starts a provider, or opens a session other than the exact id.

#[cfg(test)]
mod tests;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

const MAX_READ_BYTES: usize = 256 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;
const MAX_SESSION_META_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SKIP_BYTES: usize = 256 * 1024;
const MAX_ENTRIES: usize = 64;
const MAX_TEXT_CHARS: usize = 2_000;

/// Read a bounded snapshot or byte-cursor delta from an exact Codex session.
/// The caller owns session authorization and revocation; `home` must be the
/// trusted configured CODEX_HOME. Cursor values are rollout byte offsets.
pub(crate) fn read(home: &Path, session: &str, after: Option<u64>) -> Result<Value, String> {
    read_page(home, session, after, false)
}

pub(crate) fn latest(home: &Path, session: &str) -> Result<Value, String> {
    read_page(home, session, None, true)
}

fn read_page(
    home: &Path,
    session: &str,
    after: Option<u64>,
    newest: bool,
) -> Result<Value, String> {
    if !valid_session_id(session) {
        return Err("invalid Codex session id".into());
    }
    let home = fs::canonicalize(home).map_err(|_| "Codex home is unavailable")?;
    reject_symlink(&home.join("sessions"))?;
    let sessions_root = fs::canonicalize(home.join("sessions"))
        .map_err(|_| "Codex sessions storage is unavailable")?;
    if !sessions_root.starts_with(&home) {
        return Err("Codex sessions storage escapes CODEX_HOME".into());
    }
    let db_path = home.join("state_5.sqlite");
    reject_symlink(&db_path)?;
    let db = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "Codex thread index is unavailable or unsupported")?;
    db.busy_timeout(std::time::Duration::ZERO)
        .map_err(|_| "Codex thread index is busy")?;
    let indexed: Option<String> = db
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            [session],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Codex thread index has an unsupported schema")?;
    let indexed = indexed.ok_or("Codex session is not present in the thread index")?;
    let rollout = resolve_rollout(&home, &sessions_root, Path::new(&indexed))?;
    let path_metadata =
        fs::symlink_metadata(&rollout).map_err(|_| "Codex session rollout is unavailable")?;
    if !path_metadata.file_type().is_file() {
        return Err("Codex session rollout is not a regular file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&rollout)
        .map_err(|_| "Codex session rollout is unavailable")?;
    if !file
        .metadata()
        .map_err(|_| "could not inspect Codex session rollout")?
        .is_file()
    {
        return Err("Codex session rollout is not a regular file".into());
    }
    let file_len = file
        .metadata()
        .map_err(|_| "could not inspect Codex session rollout")?
        .len();
    let metadata_end = validate_session_meta(&mut file, session)?;

    let requested = if newest {
        file_len
            .saturating_sub(MAX_READ_BYTES as u64)
            .max(metadata_end)
    } else {
        after.unwrap_or(metadata_end)
    };
    let mut gap = requested > file_len || (newest && requested != metadata_end);
    let mut offset = if requested > file_len {
        file_len
    } else {
        requested
    };
    if offset > 0 && offset < file_len {
        file.seek(SeekFrom::Start(offset - 1))
            .map_err(|_| "could not seek Codex session rollout")?;
        let mut previous = [0u8; 1];
        file.read_exact(&mut previous)
            .map_err(|_| "could not inspect Codex session cursor")?;
        if previous[0] != b'\n' {
            let (skipped, found_boundary) = scan_to_newline(&mut file, offset, MAX_SKIP_BYTES)?;
            offset = offset.saturating_add(skipped);
            gap = true;
            if !found_boundary {
                return Ok(review_result(Vec::new(), offset, true, true));
            }
        }
    }

    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "could not seek Codex session rollout")?;
    let mut raw = Vec::with_capacity(MAX_READ_BYTES + MAX_LINE_BYTES);
    (&mut file)
        .take(MAX_READ_BYTES as u64)
        .read_to_end(&mut raw)
        .map_err(|_| "could not read Codex session rollout")?;
    let mut entries = std::collections::VecDeque::new();
    let mut command_calls = std::collections::HashSet::new();
    let mut consumed = 0usize;
    let mut truncated = false;

    for segment in raw.split_inclusive(|byte| *byte == b'\n') {
        let complete = segment.ends_with(b"\n");
        let content = segment.strip_suffix(b"\n").unwrap_or(segment);
        if !complete {
            let partial_len = segment.len();
            if partial_len > MAX_LINE_BYTES {
                let (skipped, found_boundary) = scan_to_newline(
                    &mut file,
                    offset.saturating_add(raw.len() as u64),
                    MAX_SKIP_BYTES,
                )?;
                consumed = raw.len().saturating_add(skipped as usize);
                gap = true;
                truncated = true;
                if !found_boundary {
                    break;
                }
            } else {
                // Keep a short partial final record at its start for the next delta.
                truncated = file_len > offset + consumed as u64 + partial_len as u64;
            }
            break;
        }
        consumed += segment.len();
        if content.len() > MAX_LINE_BYTES {
            gap = true;
            truncated = true;
            continue;
        }
        if let Ok(event) = serde_json::from_slice::<Value>(content) {
            if let Some((role, text)) = visible_message(&event) {
                entries.push_back(json!({"role": role, "text": cap_text(&text)}));
            } else if let Some(code) = command_exit(&event, &mut command_calls) {
                entries.push_back(json!({"role": "command", "exitCode": code}));
            }
        }
        if newest && entries.len() > MAX_ENTRIES {
            entries.pop_front();
            gap = true;
        }
        if consumed >= MAX_READ_BYTES || (!newest && entries.len() >= MAX_ENTRIES) {
            truncated = true;
            break;
        }
    }

    let next_cursor = offset.saturating_add(consumed as u64);
    Ok(review_result(entries.into(), next_cursor, gap, truncated))
}

fn review_result(entries: Vec<Value>, next_cursor: u64, gap: bool, truncated: bool) -> Value {
    let mut result = json!({"entries": entries, "nextCursor": next_cursor});
    if gap {
        result["gap"] = json!(true);
    }
    if truncated {
        result["truncated"] = json!(true);
    }
    result
}

fn scan_to_newline(file: &mut File, start: u64, limit: usize) -> Result<(u64, bool), String> {
    file.seek(SeekFrom::Start(start))
        .map_err(|_| "could not seek Codex session rollout")?;
    let mut scanned = 0u64;
    let mut chunk = [0u8; 8192];
    while scanned < limit as u64 {
        let remaining = (limit as u64 - scanned).min(chunk.len() as u64) as usize;
        let count = file
            .read(&mut chunk[..remaining])
            .map_err(|_| "could not scan Codex session boundary")?;
        if count == 0 {
            return Ok((scanned, false));
        }
        if let Some(index) = chunk[..count].iter().position(|byte| *byte == b'\n') {
            return Ok((scanned + index as u64 + 1, true));
        }
        scanned += count as u64;
    }
    Ok((scanned, false))
}

fn valid_session_id(session: &str) -> bool {
    session.len() == 36
        && session
            .bytes()
            .enumerate()
            .all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => byte == b'-',
                _ => byte.is_ascii_hexdigit(),
            })
}

#[derive(Deserialize)]
struct SessionMetaWire {
    #[serde(rename = "type")]
    kind: String,
    payload: SessionMetaPayload,
}

#[derive(Deserialize)]
struct SessionMetaPayload {
    id: String,
}

fn validate_session_meta(file: &mut File, session: &str) -> Result<u64, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "could not seek Codex session metadata")?;
    let mut buffered = BufReader::new(file.take(MAX_SESSION_META_BYTES));
    let mut deserializer = serde_json::Deserializer::from_reader(&mut buffered);
    let event = SessionMetaWire::deserialize(&mut deserializer)
        .map_err(|_| "Codex session metadata is missing, invalid, or too large")?;
    drop(deserializer);
    if event.kind != "session_meta" || event.payload.id != session {
        return Err("Codex session metadata does not match the requested id".into());
    }
    let mut offset = buffered
        .stream_position()
        .map_err(|_| "could not locate Codex session metadata boundary")?;
    let mut byte = [0u8; 1];
    while offset < MAX_SESSION_META_BYTES {
        if buffered
            .read(&mut byte)
            .map_err(|_| "could not read Codex session metadata boundary")?
            == 0
        {
            break;
        }
        offset += 1;
        if byte[0] == b'\n' {
            return Ok(offset);
        }
    }
    Err("Codex session metadata is incomplete or too large".into())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Codex storage path is unavailable")?;
    if metadata.file_type().is_symlink() {
        return Err("Codex storage symlinks are not allowed".into());
    }
    Ok(())
}

fn resolve_rollout(home: &Path, sessions_root: &Path, indexed: &Path) -> Result<PathBuf, String> {
    let candidate = if indexed.is_absolute() {
        indexed.to_path_buf()
    } else {
        home.join(indexed)
    };
    let relative = candidate
        .strip_prefix(sessions_root)
        .map_err(|_| "indexed Codex rollout escapes the sessions directory")?;
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("indexed Codex rollout has an unsafe path".into());
    }
    let mut current = sessions_root.to_path_buf();
    for part in relative.components() {
        current.push(part.as_os_str());
        reject_symlink(&current)?;
    }
    if !current.is_file() {
        return Err("indexed Codex rollout escapes the sessions directory".into());
    }
    let canonical =
        fs::canonicalize(&current).map_err(|_| "indexed Codex rollout is unavailable")?;
    if !canonical.starts_with(sessions_root) {
        return Err("indexed Codex rollout escapes the sessions directory".into());
    }
    Ok(canonical)
}

// Only pair an exec call with its own CLI envelope within this page. Never
// interpret command stdout as evidence or disclose the command/arguments.
fn command_exit(event: &Value, pending: &mut std::collections::HashSet<String>) -> Option<i32> {
    if event.get("type")?.as_str()? != "response_item" {
        return None;
    }
    let item = event.get("payload")?;
    let id = item.get("call_id")?.as_str()?;
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    match item.get("type")?.as_str()? {
        "function_call" if item.get("name")?.as_str()? == "exec_command" => {
            if pending.len() < MAX_ENTRIES {
                pending.insert(id.to_owned());
            }
            None
        }
        "function_call_output" if pending.remove(id) => {
            let mut lines = item.get("output")?.as_str()?.lines();
            lines.next()?.strip_prefix("Chunk ID: ")?;
            lines.next()?.strip_prefix("Wall time: ")?;
            lines
                .next()?
                .strip_prefix("Process exited with code ")?
                .parse()
                .ok()
        }
        _ => None,
    }
}

fn visible_message(event: &Value) -> Option<(&'static str, String)> {
    let event_type = event.get("type")?.as_str()?;
    let payload = event.get("payload")?;
    if event_type != "event_msg" {
        return None;
    }
    if payload.get("type")?.as_str()? == "item_completed" {
        let item = payload.get("item")?;
        let (role, expected) = match item.get("type")?.as_str()? {
            "UserMessage" => ("user", "text"),
            "AgentMessage" => ("assistant", "Text"),
            _ => return None,
        };
        let parts: Vec<_> = item
            .get("content")?
            .as_array()?
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some(expected))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect();
        return (!parts.is_empty()).then(|| (role, parts.join("\n")));
    }
    let role = match payload.get("type")?.as_str()? {
        "user_message" => "user",
        "agent_message" => "assistant",
        _ => return None,
    };
    Some((role, payload.get("message")?.as_str()?.to_string()))
}

fn cap_text(text: &str) -> String {
    let mut output: String = text.chars().take(MAX_TEXT_CHARS).collect();
    if text.chars().count() > MAX_TEXT_CHARS {
        output.push('…');
    }
    output
}
