use std::path::{Path, PathBuf};

// Where an offload store lives, and when it moves.
//
// Ephemeral stores sit in the temp directory and are thrown away. A session
// that grows past the configured threshold is promoted into the project, so
// long or important work survives a restart. The project directory ignores
// itself — `.polakapi/.gitignore` containing `*` excludes the whole subtree
// including that file — so the user's own .gitignore is never touched.

pub const STORE_DIR: &str = ".polakapi";
const SELF_IGNORE: &str = "*\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Storage {
    Ephemeral,
    Promote,
    Project,
}

impl Storage {
    pub fn from_label(value: &str) -> Self {
        match value {
            "ephemeral" => Storage::Ephemeral,
            "project" => Storage::Project,
            _ => Storage::Promote,
        }
    }
}

/// Session ids come from the PTY layer as UUIDs, but this guards the path join
/// regardless of who calls it.
pub fn is_safe_session(session: &str) -> bool {
    !session.is_empty()
        && session.len() <= 128
        && session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Stores are per CLI session, not per terminal: `/clear` in the same terminal
/// must start empty, and resuming a session must bring its data back. Falls back
/// to the terminal alone when no session was recorded.
pub fn session_key(pty_id: &str, cli_session_id: Option<&str>) -> String {
    match cli_session_id {
        Some(session) if !session.is_empty() => format!("{pty_id}-{session}"),
        _ => pty_id.to_string(),
    }
}

/// The store key for the terminal this process runs in, from the environment
/// the PTY layer injects.
pub fn session_key_from_env() -> Option<String> {
    let pty_id = std::env::var("POLAKAPI_PTY_ID").ok()?;
    let session = std::env::var_os("POLAKAPI_DB_PATH")
        .and_then(|db| crate::db::agent_session::current(std::path::Path::new(&db), &pty_id));
    Some(session_key(&pty_id, session.as_deref()))
}

pub fn temp_store(session: &str) -> Option<PathBuf> {
    if !is_safe_session(session) {
        return None;
    }
    Some(
        std::env::temp_dir()
            .join("polakapi")
            .join("ctx")
            .join(session),
    )
}

pub fn project_store(project: &Path, session: &str) -> Option<PathBuf> {
    if !is_safe_session(session) {
        return None;
    }
    Some(project.join(STORE_DIR).join("ctx").join(session))
}

/// True once this session's data belongs in the project rather than in temp.
pub fn should_persist(storage: Storage, sources: u64, promote_after: u64) -> bool {
    match storage {
        Storage::Ephemeral => false,
        Storage::Project => true,
        Storage::Promote => sources >= promote_after,
    }
}

/// Deletes ephemeral stores left behind by sessions that are gone. Called at
/// startup: a store whose pane died never gets the chance to clean up after
/// itself, and temp directories survive reboots on most systems.
pub fn sweep_temp(keep: &[String], max_age: std::time::Duration) -> Result<usize, String> {
    sweep_temp_root(&temp_root(), keep, max_age)
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join("polakapi").join("ctx")
}

/// Root taken as an argument so this can be exercised without touching the
/// shared temp directory other sessions are using.
pub fn sweep_temp_root(
    root: &Path,
    keep: &[String],
    max_age: std::time::Duration,
) -> Result<usize, String> {
    if !root.exists() {
        return Ok(0);
    }
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    let entries =
        std::fs::read_dir(root).map_err(|e| format!("could not read {}: {e}", root.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if keep.contains(&name) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= max_age);
        if stale && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Makes `<project>/.polakapi/` exclude itself from git. Idempotent, and it
/// never reads or writes the project's own .gitignore.
pub fn ensure_self_ignored(project: &Path) -> Result<(), String> {
    let dir = project.join(STORE_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let ignore = dir.join(".gitignore");
    if ignore.is_file() {
        return Ok(());
    }
    std::fs::write(&ignore, SELF_IGNORE)
        .map_err(|e| format!("could not write {}: {e}", ignore.display()))
}

/// Moves a store into the project, falling back to a copy when the temp
/// directory is on a different filesystem — the usual case on Linux.
pub fn promote(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_dir(from, to)?;
    std::fs::remove_dir_all(from).map_err(|e| format!("could not clear {}: {e}", from.display()))
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("could not create {}: {e}", to.display()))?;
    let entries =
        std::fs::read_dir(from).map_err(|e| format!("could not read {}: {e}", from.display()))?;
    for entry in entries.flatten() {
        let target = to.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("could not inspect {}: {e}", entry.path().display()))?;
        if file_type.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)
                .map_err(|e| format!("could not copy into {}: {e}", target.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_cli_session_in_the_same_terminal_gets_its_own_store() {
        let before = session_key("pty-1", Some("session-a"));
        let after_clear = session_key("pty-1", Some("session-b"));
        assert_ne!(before, after_clear);
        assert!(is_safe_session(&before));
        assert_eq!(session_key("pty-1", None), "pty-1");
        assert_eq!(session_key("pty-1", Some("")), "pty-1");
    }

    #[test]
    fn promotion_waits_for_the_threshold() {
        assert!(!should_persist(Storage::Promote, 19, 20));
        assert!(should_persist(Storage::Promote, 20, 20));
    }

    #[test]
    fn the_other_two_modes_ignore_the_threshold() {
        assert!(!should_persist(Storage::Ephemeral, 9_999, 20));
        assert!(should_persist(Storage::Project, 0, 20));
    }

    #[test]
    fn rejects_a_session_id_that_would_escape_the_directory() {
        assert!(!is_safe_session("../../etc"));
        assert!(!is_safe_session("a/b"));
        assert!(!is_safe_session(""));
        assert!(is_safe_session("fa8986a6-a3c9-465c-919f"));
        assert!(temp_store("../escape").is_none());
        assert!(project_store(Path::new("/tmp"), "../escape").is_none());
    }

    #[test]
    fn the_store_directory_ignores_itself() {
        let project = tempfile::tempdir().unwrap();
        ensure_self_ignored(project.path()).unwrap();
        let ignore = project.path().join(STORE_DIR).join(".gitignore");
        assert_eq!(std::fs::read_to_string(&ignore).unwrap(), "*\n");
        // The project's own .gitignore is never created or touched.
        assert!(!project.path().join(".gitignore").exists());
    }

    #[test]
    fn self_ignore_does_not_overwrite_an_existing_file() {
        let project = tempfile::tempdir().unwrap();
        let dir = project.path().join(STORE_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "custom\n").unwrap();
        ensure_self_ignored(project.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "custom\n"
        );
    }

    #[test]
    fn promote_moves_the_whole_tree() {
        let root = tempfile::tempdir().unwrap();
        let from = root.path().join("from");
        std::fs::create_dir_all(from.join("nested")).unwrap();
        std::fs::write(from.join("a.db"), b"one").unwrap();
        std::fs::write(from.join("nested/b.txt"), b"two").unwrap();

        let to = root.path().join("to");
        promote(&from, &to).unwrap();
        assert_eq!(std::fs::read_to_string(to.join("a.db")).unwrap(), "one");
        assert_eq!(
            std::fs::read_to_string(to.join("nested/b.txt")).unwrap(),
            "two"
        );
        assert!(!from.exists());
    }

    #[test]
    fn sweeping_keeps_live_sessions_and_drops_stale_ones() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("live")).unwrap();
        std::fs::create_dir_all(root.path().join("dead")).unwrap();

        // Zero age means everything not explicitly kept counts as stale.
        let removed = sweep_temp_root(
            root.path(),
            &["live".to_string()],
            std::time::Duration::ZERO,
        )
        .unwrap();
        assert_eq!(removed, 1);
        assert!(root.path().join("live").exists(), "a live session survives");
        assert!(
            !root.path().join("dead").exists(),
            "a dead session is removed"
        );
    }

    #[test]
    fn sweeping_spares_stores_that_are_still_young() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("fresh")).unwrap();
        let removed =
            sweep_temp_root(root.path(), &[], std::time::Duration::from_secs(3600)).unwrap();
        assert_eq!(removed, 0);
        assert!(root.path().join("fresh").exists());
    }

    #[test]
    fn sweeping_a_root_that_does_not_exist_is_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("never-created");
        assert_eq!(
            sweep_temp_root(&missing, &[], std::time::Duration::ZERO).unwrap(),
            0
        );
    }

    #[test]
    fn promoting_a_store_that_never_existed_is_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        promote(&root.path().join("missing"), &root.path().join("to")).unwrap();
    }
}
