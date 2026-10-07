use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextIdentity {
    pub session_id: Option<String>,
    pub transcript_path: Option<PathBuf>,
}

pub fn resolve(dir: Option<&Path>, session_id: Option<String>) -> ContextIdentity {
    let transcript_path = dir.and_then(|dir| match session_id.as_deref() {
        Some(id) => Some(dir.join(format!("{id}.jsonl"))).filter(|path| path.is_file()),
        None => super::newest_jsonl(dir),
    });
    ContextIdentity {
        session_id,
        transcript_path,
    }
}

pub fn read_bound<T>(
    expected: &ContextIdentity,
    current: impl Fn() -> ContextIdentity,
    read: impl FnOnce(Option<&Path>) -> Result<T, String>,
) -> Result<T, String> {
    if &current() != expected {
        return Err("STALE_CONTEXT: reload the context for this session".into());
    }
    let result = read(expected.transcript_path.as_deref());
    if &current() != expected {
        return Err("STALE_CONTEXT: reload the context for this session".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::super::transcript;
    use super::*;
    use crate::db::agent_session;

    #[test]
    fn clear_rejects_old_entry_and_search_even_when_entry_ids_are_reused() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("sessions.db");
        for (session, body) in [("A", "old body"), ("B", "new body")] {
            std::fs::write(
                dir.path().join(format!("{session}.jsonl")),
                serde_json::json!({"type": "user", "message": {"content": body}}).to_string(),
            )
            .unwrap();
        }
        let current = || resolve(Some(dir.path()), agent_session::current(&db, "pane"));
        agent_session::record_start(&db, "pane", "claude", "A", None).unwrap();
        let old = current();
        let old_entries = transcript::parse(old.transcript_path.as_ref().unwrap())
            .unwrap()
            .entries;
        agent_session::record_start(&db, "pane", "claude", "B", None).unwrap();
        let new = current();
        let new_entries = transcript::parse(new.transcript_path.as_ref().unwrap())
            .unwrap()
            .entries;
        assert_eq!(old_entries[0].id, new_entries[0].id);
        assert!(read_bound(&old, current, |path| Ok(transcript::entry_body(
            path.unwrap(),
            0
        )))
        .unwrap_err()
        .contains("STALE_CONTEXT"));
        assert!(read_bound(&old, current, |path| transcript::search(
            path.unwrap(),
            "body"
        ))
        .unwrap_err()
        .contains("STALE_CONTEXT"));
        assert_eq!(
            read_bound(&new, current, |path| Ok(transcript::entry_body(
                path.unwrap(),
                0
            )))
            .unwrap()
            .as_deref(),
            Some("new body")
        );
    }

    #[test]
    fn clear_during_read_discards_the_result_and_missing_new_transcript_stays_empty() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("sessions.db");
        std::fs::write(dir.path().join("A.jsonl"), "fixture").unwrap();
        agent_session::record_start(&db, "pane", "claude", "A", None).unwrap();
        let current = || resolve(Some(dir.path()), agent_session::current(&db, "pane"));
        let old = current();
        let result = read_bound(&old, current, |_| {
            agent_session::record_start(&db, "pane", "claude", "B", None).unwrap();
            Ok("old body")
        });
        assert!(result.unwrap_err().contains("STALE_CONTEXT"));
        assert_eq!(current().session_id.as_deref(), Some("B"));
        assert!(current().transcript_path.is_none());
    }

    #[test]
    fn unknown_session_fallback_is_bound_to_the_selected_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("A.jsonl");
        std::fs::write(&first, "fixture").unwrap();
        let old = resolve(Some(dir.path()), None);
        std::fs::remove_file(first).unwrap();
        std::fs::write(dir.path().join("B.jsonl"), "fixture").unwrap();
        let result = read_bound(
            &old,
            || resolve(Some(dir.path()), None),
            |_| Ok("wrong body"),
        );
        assert!(result.unwrap_err().contains("STALE_CONTEXT"));
    }
}
