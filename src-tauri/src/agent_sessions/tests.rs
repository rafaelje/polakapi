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
fn limits_claude_transcript_scanning() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project-one");
    std::fs::create_dir_all(&project).unwrap();
    let path = project.join("session-1.jsonl");
    let mut file = File::create(&path).unwrap();
    for _ in 0..CLAUDE_MAX_SCANNED_LINES {
        writeln!(file, "{}", json!({ "type": "assistant" })).unwrap();
    }
    writeln!(
        file,
        "{}",
        json!({
            "type": "user",
            "message": { "content": "This title is beyond the scan limit" }
        })
    )
    .unwrap();

    let sessions = claude_sessions_from_dir(temp.path()).unwrap();
    assert_eq!(sessions[0].title, "Untitled session");
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
