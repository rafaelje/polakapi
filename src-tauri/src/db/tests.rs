use super::*;
use tempfile::TempDir;

fn tmp_db() -> (TempDir, Db) {
    let dir = TempDir::new().expect("tmpdir");
    let db = Db::open(&dir.path().join("test.db")).expect("open");
    (dir, db)
}

#[test]
fn opens_and_migrates_fresh_db() {
    let (_dir, db) = tmp_db();
    let version: i64 = db
        .conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(version, 1);
}

#[test]
fn idempotent_migrations_do_not_reapply() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("a.db");
    let _ = Db::open(&path).unwrap();
    let db = Db::open(&path).unwrap();
    let version: i64 = db
        .conn
        .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(version, 1);
}

#[test]
fn apply_event_full_flow_inserts_prompt_and_response() {
    let (_dir, db) = tmp_db();
    let events = [
        CaptureEvent::SessionStart {
            pty_id: "pty-1".into(),
            cli: "claude".into(),
            cli_session_id: Some("cc-sess".into()),
            cwd: Some("/tmp".into()),
        },
        CaptureEvent::UserPrompt {
            pty_id: "pty-1".into(),
            user_input: "hello world".into(),
        },
        CaptureEvent::AssistantStop {
            pty_id: "pty-1".into(),
            response_text: Some("hi there".into()),
            tokens_in: Some(10),
            tokens_out: Some(5),
            cost_usd: Some(0.001),
            elapsed_ms: Some(120),
            error: None,
        },
        CaptureEvent::SessionEnd {
            pty_id: "pty-1".into(),
        },
    ];
    for event in &events {
        apply_event(&db, event).expect("apply");
    }

    let sessions = db.list_sessions().expect("list");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].prompt_count, 1);
    assert_eq!(sessions[0].status, "closed");
    assert_eq!(sessions[0].title.as_deref(), Some("hello world"));

    let prompts = db
        .list_prompts_by_session(sessions[0].id)
        .expect("list prompts");
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].has_response);

    let full = db.get_prompt(prompts[0].id).expect("get").unwrap();
    assert_eq!(full.user_input.as_deref(), Some("hello world"));
    assert_eq!(full.response_text.as_deref(), Some("hi there"));
    assert_eq!(full.tokens_in, Some(10));
}

#[test]
fn search_matches_user_input_or_response() {
    let (_dir, db) = tmp_db();
    apply_event(
        &db,
        &CaptureEvent::SessionStart {
            pty_id: "p".into(),
            cli: "claude".into(),
            cli_session_id: None,
            cwd: None,
        },
    )
    .unwrap();
    apply_event(
        &db,
        &CaptureEvent::UserPrompt {
            pty_id: "p".into(),
            user_input: "how do I parse JSON in rust".into(),
        },
    )
    .unwrap();
    apply_event(
        &db,
        &CaptureEvent::AssistantStop {
            pty_id: "p".into(),
            response_text: Some("use serde_json::from_str".into()),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
            elapsed_ms: None,
            error: None,
        },
    )
    .unwrap();

    assert_eq!(db.search_prompts("parse").expect("search").len(), 1);
    assert_eq!(db.search_prompts("serde_json").expect("search").len(), 1);
    assert!(db.search_prompts("nonexistent").expect("search").is_empty());
}

#[test]
fn multiple_prompts_in_session_increment_seq() {
    let (_dir, db) = tmp_db();
    apply_event(
        &db,
        &CaptureEvent::SessionStart {
            pty_id: "p".into(),
            cli: "claude".into(),
            cli_session_id: None,
            cwd: None,
        },
    )
    .unwrap();
    for index in 0..3 {
        apply_event(
            &db,
            &CaptureEvent::UserPrompt {
                pty_id: "p".into(),
                user_input: format!("turn {index}"),
            },
        )
        .unwrap();
        apply_event(
            &db,
            &CaptureEvent::AssistantStop {
                pty_id: "p".into(),
                response_text: Some(format!("answer {index}")),
                tokens_in: None,
                tokens_out: None,
                cost_usd: None,
                elapsed_ms: None,
                error: None,
            },
        )
        .unwrap();
    }

    let sessions = db.list_sessions().expect("list");
    let prompts = db.list_prompts_by_session(sessions[0].id).expect("list");
    assert_eq!(
        prompts.iter().map(|prompt| prompt.seq).collect::<Vec<_>>(),
        [1, 2, 3]
    );
}

#[test]
fn delete_sessions_removes_prompts_and_deduplicates_ids() {
    let (_dir, mut db) = tmp_db();
    for pty_id in ["p1", "p2"] {
        apply_event(
            &db,
            &CaptureEvent::SessionStart {
                pty_id: pty_id.into(),
                cli: "claude".into(),
                cli_session_id: None,
                cwd: None,
            },
        )
        .unwrap();
        apply_event(
            &db,
            &CaptureEvent::UserPrompt {
                pty_id: pty_id.into(),
                user_input: format!("prompt {pty_id}"),
            },
        )
        .unwrap();
    }

    let deleted_id = lookup_session_id_by_pty(&db, "p1").unwrap();
    let kept_id = lookup_session_id_by_pty(&db, "p2").unwrap();
    let deleted = db
        .delete_sessions(&[deleted_id, deleted_id, 999_999])
        .expect("delete");
    let deleted_prompt_count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM prompts WHERE session_id = ?1",
            params![deleted_id],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(deleted, 1);
    assert_eq!(deleted_prompt_count, 0);
    assert_eq!(db.list_sessions().unwrap().len(), 1);
    assert!(db.list_prompts_by_session(deleted_id).unwrap().is_empty());
    assert_eq!(db.list_prompts_by_session(kept_id).unwrap().len(), 1);
}
