use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};
use std::cmp::Reverse;
use std::fs::File;
use std::io::{BufRead, BufReader as StdBufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};

const CODEX_PAGE_SIZE: usize = 100;
const CODEX_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub key: String,
    pub agent: String,
    pub native_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub kind: String,
    pub status: String,
    pub archived: bool,
    pub resumable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionWarning {
    pub agent: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionsResult {
    pub sessions: Vec<AgentSession>,
    pub warnings: Vec<AgentSessionWarning>,
}

#[tauri::command]
pub async fn agent_list_sessions() -> Result<AgentSessionsResult, String> {
    let claude = tokio::task::spawn_blocking(claude_sessions_from_default_store);
    let opencode = tokio::task::spawn_blocking(opencode_sessions_from_default_store);
    let (codex, claude, opencode) = tokio::join!(codex_sessions(), claude, opencode);

    let mut sessions = Vec::new();
    let mut warnings = Vec::new();
    append_provider_result(&mut sessions, &mut warnings, "codex", codex);
    append_provider_result(
        &mut sessions,
        &mut warnings,
        "claude",
        claude.map_err(|error| format!("session discovery task failed: {error}"))?,
    );
    append_provider_result(
        &mut sessions,
        &mut warnings,
        "opencode",
        opencode.map_err(|error| format!("session discovery task failed: {error}"))?,
    );
    sort_sessions(&mut sessions);

    Ok(AgentSessionsResult { sessions, warnings })
}

fn append_provider_result(
    sessions: &mut Vec<AgentSession>,
    warnings: &mut Vec<AgentSessionWarning>,
    agent: &str,
    result: Result<Vec<AgentSession>, String>,
) {
    match result {
        Ok(mut discovered) => sessions.append(&mut discovered),
        Err(message) => warnings.push(AgentSessionWarning {
            agent: agent.to_string(),
            message,
        }),
    }
}

fn sort_sessions(sessions: &mut [AgentSession]) {
    sessions.sort_by_key(|session| {
        (
            Reverse(session.updated_at),
            Reverse(session.created_at),
            session.key.clone(),
        )
    });
}

async fn codex_sessions() -> Result<Vec<AgentSession>, String> {
    let mut child = Command::new("codex")
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("could not start codex app-server: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "codex app-server stdin was unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "codex app-server stdout was unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);

    write_rpc(
        &mut stdin,
        &json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "polakapi",
                    "title": "PolakAPI",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )
    .await?;
    read_rpc_response(&mut reader, 1).await?;
    write_rpc(
        &mut stdin,
        &json!({ "method": "initialized", "params": {} }),
    )
    .await?;

    let mut sessions = Vec::new();
    let mut request_id = 2_i64;
    for archived in [false, true] {
        let mut cursor: Option<String> = None;
        for _ in 0..100 {
            write_rpc(
                &mut stdin,
                &json!({
                    "method": "thread/list",
                    "id": request_id,
                    "params": {
                        "cursor": cursor,
                        "limit": CODEX_PAGE_SIZE,
                        "sortKey": "updated_at",
                        "sortDirection": "desc",
                        "archived": archived,
                        "sourceKinds": [
                            "cli",
                            "vscode",
                            "exec",
                            "appServer",
                            "subAgent",
                            "subAgentReview",
                            "subAgentCompact",
                            "subAgentThreadSpawn",
                            "subAgentOther",
                            "unknown"
                        ]
                    }
                }),
            )
            .await?;
            let response = read_rpc_response(&mut reader, request_id).await?;
            let result = response
                .get("result")
                .ok_or_else(|| rpc_error_message(&response, "codex thread/list failed"))?;
            if let Some(items) = result.get("data").and_then(Value::as_array) {
                sessions.extend(
                    items
                        .iter()
                        .filter_map(|thread| parse_codex_thread(thread, archived)),
                );
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            request_id += 1;
            if cursor.is_none() {
                break;
            }
        }
    }

    let _ = child.kill().await;
    Ok(sessions)
}

async fn write_rpc(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    stdin
        .write_all(&encoded)
        .await
        .map_err(|error| format!("could not write to codex app-server: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("could not flush codex app-server request: {error}"))
}

async fn read_rpc_response(
    reader: &mut BufReader<ChildStdout>,
    expected_id: i64,
) -> Result<Value, String> {
    loop {
        let mut line = String::new();
        let read = tokio::time::timeout(CODEX_RESPONSE_TIMEOUT, reader.read_line(&mut line))
            .await
            .map_err(|_| "timed out waiting for codex app-server".to_string())?
            .map_err(|error| format!("could not read codex app-server output: {error}"))?;
        if read == 0 {
            return Err("codex app-server closed before responding".to_string());
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("id").and_then(Value::as_i64) == Some(expected_id) {
            if message.get("error").is_some() {
                return Err(rpc_error_message(
                    &message,
                    "codex app-server request failed",
                ));
            }
            return Ok(message);
        }
    }
}

fn rpc_error_message(message: &Value, fallback: &str) -> String {
    message
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn parse_codex_thread(thread: &Value, archived: bool) -> Option<AgentSession> {
    let native_id = thread.get("id")?.as_str()?.to_string();
    let preview = thread
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .or_else(|| thread.get("preview").and_then(Value::as_str))
        .unwrap_or("Untitled session");
    let source = thread.get("source");
    let is_subagent = thread
        .get("parentThreadId")
        .is_some_and(|value| !value.is_null())
        || source.is_some_and(|value| value.get("subAgent").is_some());
    let kind = if is_subagent {
        "subagent"
    } else {
        match source.and_then(Value::as_str) {
            Some("exec") | Some("appServer") => "non-interactive",
            _ => "interactive",
        }
    };
    let status = thread
        .pointer("/status/type")
        .and_then(Value::as_str)
        .unwrap_or("saved");

    Some(AgentSession {
        key: format!("codex:{native_id}"),
        agent: "codex".to_string(),
        native_id,
        title: truncate_preview(preview),
        cwd: thread
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        created_at: seconds_to_millis(thread.get("createdAt").and_then(Value::as_i64)),
        updated_at: seconds_to_millis(thread.get("updatedAt").and_then(Value::as_i64)),
        kind: kind.to_string(),
        status: status.to_string(),
        archived,
        resumable: !thread
            .get("ephemeral")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn seconds_to_millis(value: Option<i64>) -> i64 {
    value.unwrap_or(0).saturating_mul(1000)
}

fn claude_sessions_from_default_store() -> Result<Vec<AgentSession>, String> {
    claude_sessions_from_dir(&home_dir()?.join(".claude/projects"))
}

fn claude_sessions_from_dir(root: &Path) -> Result<Vec<AgentSession>, String> {
    if !root.exists() {
        return Err(format!("session store not found at {}", root.display()));
    }
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files)?;
    let mut sessions = Vec::new();
    for path in files {
        if let Some(session) = parse_claude_session_file(root, &path) {
            sessions.push(session);
        }
    }
    Ok(sessions)
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

fn parse_claude_session_file(root: &Path, path: &Path) -> Option<AgentSession> {
    let file = File::open(path).ok()?;
    let mut native_id = path.file_stem()?.to_string_lossy().to_string();
    let mut cwd = None;
    let mut title = None;
    for line in StdBufReader::new(file).lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(value) = event.get("sessionId").and_then(Value::as_str) {
            native_id = value.to_string();
        }
        if cwd.is_none() {
            cwd = event.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        if title.is_none()
            && event.get("type").and_then(Value::as_str) == Some("user")
            && event.get("isMeta").and_then(Value::as_bool) != Some(true)
        {
            title = extract_message_text(event.get("message"));
        }
        if cwd.is_some() && title.is_some() {
            break;
        }
    }
    let metadata = std::fs::metadata(path).ok();
    let updated_at = metadata
        .as_ref()
        .and_then(|value| value.modified().ok())
        .map(system_time_millis)
        .unwrap_or(0);
    let created_at = metadata
        .as_ref()
        .and_then(|value| value.created().ok())
        .map(system_time_millis)
        .unwrap_or(updated_at);
    let relative = path.strip_prefix(root).ok();
    let is_subagent = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("agent-"))
        || relative.is_some_and(|value| value.components().count() > 2);

    Some(AgentSession {
        key: format!("claude:{native_id}"),
        agent: "claude".to_string(),
        native_id,
        title: truncate_preview(title.as_deref().unwrap_or("Untitled session")),
        cwd,
        created_at,
        updated_at,
        kind: if is_subagent {
            "subagent".to_string()
        } else {
            "interactive".to_string()
        },
        status: "saved".to_string(),
        archived: false,
        resumable: !is_subagent,
    })
}

fn extract_message_text(message: Option<&Value>) -> Option<String> {
    let content = message?.get("content")?;
    let text = if let Some(value) = content.as_str() {
        value.to_string()
    } else {
        content
            .as_array()?
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn opencode_sessions_from_default_store() -> Result<Vec<AgentSession>, String> {
    opencode_sessions_from_db(&home_dir()?.join(".local/share/opencode/opencode.db"))
}

fn opencode_sessions_from_db(path: &Path) -> Result<Vec<AgentSession>, String> {
    if !path.exists() {
        return Err(format!("session store not found at {}", path.display()));
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("could not open {} read-only: {error}", path.display()))?;
    let mut statement = connection
        .prepare(
            "SELECT id, title, directory, time_created, time_updated, time_archived, parent_id
             FROM session
             ORDER BY time_updated DESC",
        )
        .map_err(|error| format!("could not query OpenCode sessions: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let native_id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let cwd: String = row.get(2)?;
            let created_at: i64 = row.get(3)?;
            let updated_at: i64 = row.get(4)?;
            let archived_at: Option<i64> = row.get(5)?;
            let parent_id: Option<String> = row.get(6)?;
            let is_subagent = parent_id.is_some();
            Ok(AgentSession {
                key: format!("opencode:{native_id}"),
                agent: "opencode".to_string(),
                native_id,
                title: truncate_preview(if title.trim().is_empty() {
                    "Untitled session"
                } else {
                    &title
                }),
                cwd: (!cwd.trim().is_empty()).then_some(cwd),
                created_at,
                updated_at,
                kind: if is_subagent {
                    "subagent".to_string()
                } else {
                    "interactive".to_string()
                },
                status: "saved".to_string(),
                archived: archived_at.is_some(),
                resumable: !is_subagent,
            })
        })
        .map_err(|error| format!("could not read OpenCode sessions: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("could not decode OpenCode session: {error}"))
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "user home directory is unavailable".to_string())
}

fn system_time_millis(value: SystemTime) -> i64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn truncate_preview(value: &str) -> String {
    let trimmed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = trimmed.chars();
    let truncated: String = chars.by_ref().take(180).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else if truncated.is_empty() {
        "Untitled session".to_string()
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::io::Write;

    #[test]
    fn parses_codex_thread_metadata() {
        let session = parse_codex_thread(
            &json!({
                "id": "0198-test",
                "name": null,
                "preview": "Fix the session browser",
                "cwd": "/workspace/one",
                "createdAt": 100,
                "updatedAt": 200,
                "source": "exec",
                "status": { "type": "active" },
                "ephemeral": false
            }),
            false,
        )
        .unwrap();

        assert_eq!(session.key, "codex:0198-test");
        assert_eq!(session.title, "Fix the session browser");
        assert_eq!(session.created_at, 100_000);
        assert_eq!(session.updated_at, 200_000);
        assert_eq!(session.kind, "non-interactive");
        assert_eq!(session.status, "active");
        assert!(session.resumable);
    }

    #[test]
    fn reads_claude_metadata_without_returning_transcript() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project-one");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join("session-1.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "user",
                "sessionId": "session-1",
                "cwd": "/workspace/claude",
                "message": { "content": [{ "type": "text", "text": "Investigate global sessions" }] }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "assistant",
                "sessionId": "session-1",
                "message": { "content": "private assistant transcript" }
            })
        )
        .unwrap();

        let sessions = claude_sessions_from_dir(temp.path()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "Investigate global sessions");
        assert_eq!(sessions[0].cwd.as_deref(), Some("/workspace/claude"));
        assert!(!sessions[0].title.contains("private assistant"));
    }

    #[test]
    fn reads_opencode_database_in_read_only_mode() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("opencode.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    directory TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    time_archived INTEGER,
                    parent_id TEXT
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)",
                params!["ses_1", "OpenCode work", "/workspace/open", 10_i64, 20_i64],
            )
            .unwrap();
        drop(connection);

        let sessions = opencode_sessions_from_db(&path).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].key, "opencode:ses_1");
        assert_eq!(sessions[0].cwd.as_deref(), Some("/workspace/open"));
        assert_eq!(sessions[0].updated_at, 20);
    }

    #[test]
    fn sorts_sessions_and_preserves_partial_results() {
        let mut sessions = Vec::new();
        let mut warnings = Vec::new();
        append_provider_result(
            &mut sessions,
            &mut warnings,
            "codex",
            Err("not installed".to_string()),
        );
        append_provider_result(
            &mut sessions,
            &mut warnings,
            "claude",
            Ok(vec![AgentSession {
                key: "claude:old".to_string(),
                agent: "claude".to_string(),
                native_id: "old".to_string(),
                title: "Old".to_string(),
                cwd: None,
                created_at: 1,
                updated_at: 2,
                kind: "interactive".to_string(),
                status: "saved".to_string(),
                archived: false,
                resumable: true,
            }]),
        );
        sessions.push(AgentSession {
            key: "opencode:new".to_string(),
            agent: "opencode".to_string(),
            native_id: "new".to_string(),
            title: "New".to_string(),
            cwd: None,
            created_at: 3,
            updated_at: 4,
            kind: "interactive".to_string(),
            status: "saved".to_string(),
            archived: false,
            resumable: true,
        });

        sort_sessions(&mut sessions);
        assert_eq!(sessions[0].key, "opencode:new");
        assert_eq!(sessions[1].key, "claude:old");
        assert_eq!(warnings[0].agent, "codex");
    }
}
