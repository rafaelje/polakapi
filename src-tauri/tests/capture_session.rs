use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use polakapi_lib::db::Db;
use serde_json::{json, Value};

fn capture(db_path: &Path, event: Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_polakapi"))
        .arg("capture")
        .env("POLAKAPI_DB_PATH", db_path)
        .env("POLAKAPI_LOG_PATH", db_path.with_extension("log"))
        .env("POLAKAPI_PTY_ID", "pty-1")
        .env("POLAKAPI_CLI", "codex")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(event.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn session_end_capture_closes_only_its_terminal_session() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("polakapi.db");
    capture(
        &path,
        json!({
            "hook_event_name": "SessionStart",
            "session_id": "codex-session",
            "cwd": dir.path(),
        }),
    );
    let db = Db::open(&path).unwrap();
    db.upsert_session("pty-2", "claude", Some("other-session"), None)
        .unwrap();
    assert!(db.agent_for_pty("pty-1").unwrap().is_some());

    capture(&path, json!({ "hook_event_name": "SessionEnd" }));

    assert_eq!(db.agent_for_pty("pty-1").unwrap(), None);
    assert_eq!(
        db.agent_for_pty("pty-2").unwrap(),
        Some(("claude".to_string(), None))
    );
    let log = std::fs::read_to_string(path.with_extension("log")).unwrap();
    assert!(log.contains("event=session-end"));
}
