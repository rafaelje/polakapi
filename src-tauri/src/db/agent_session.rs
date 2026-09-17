use std::path::Path;

use rusqlite::{params, Connection, OpenFlags};

use super::Db;

// Which CLI session is running in each polakapi terminal right now.
//
// A terminal outlives the sessions inside it: `/clear` starts a new session in
// the same process, and quitting and relaunching the CLI starts another. Both
// the /context window and the context mode store are about *the current
// session*, so both look it up here instead of guessing from file times.
//
// Written from hook helpers, which run as separate processes with only
// POLAKAPI_DB_PATH to go on, so these take a path rather than the app's handle.

/// Records that `cli_session_id` just started in terminal `pty_id`.
pub fn record_start(
    db_path: &Path,
    pty_id: &str,
    cli: &str,
    cli_session_id: &str,
    cwd: Option<&str>,
) -> Result<(), String> {
    let db = Db::open(db_path)?;
    db.upsert_session(pty_id, cli, Some(cli_session_id), cwd)?;
    Ok(())
}

/// The session most recently started in terminal `pty_id`, if any was recorded.
pub fn current(db_path: &Path, pty_id: &str) -> Option<String> {
    // Read-only: a lookup must never create the database or run migrations.
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    conn.query_row(
        "SELECT cli_session_id FROM sessions
         WHERE pty_id = ?1 AND cli_session_id IS NOT NULL
         ORDER BY id DESC LIMIT 1",
        params![pty_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cleared_session_replaces_the_previous_one_in_the_same_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("polakapi.db");
        record_start(&db, "pty-1", "claude", "first", Some("/repo")).unwrap();
        assert_eq!(current(&db, "pty-1").as_deref(), Some("first"));

        // `/clear` in the same terminal.
        record_start(&db, "pty-1", "claude", "second", Some("/repo")).unwrap();
        assert_eq!(current(&db, "pty-1").as_deref(), Some("second"));
    }

    #[test]
    fn terminals_do_not_see_each_others_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("polakapi.db");
        record_start(&db, "pty-1", "claude", "one", None).unwrap();
        record_start(&db, "pty-2", "claude", "two", None).unwrap();
        assert_eq!(current(&db, "pty-1").as_deref(), Some("one"));
        assert_eq!(current(&db, "pty-2").as_deref(), Some("two"));
        assert_eq!(current(&db, "pty-3"), None);
    }

    #[test]
    fn looking_up_never_creates_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("polakapi.db");
        assert_eq!(current(&db, "pty-1"), None);
        assert!(!db.exists());
    }
}
