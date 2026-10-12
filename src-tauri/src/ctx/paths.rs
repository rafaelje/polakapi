use std::path::{Path, PathBuf};

// Where an offload store lives, and when it moves.
//
// Ephemeral stores sit in the temp directory and are thrown away. A session
// that grows past the configured threshold is promoted into the project, so
// long or important work survives a restart. The project directory ignores
// itself — `.polakapi/.gitignore` containing `*` excludes the whole subtree
// including that file — so the user's own .gitignore is never touched.

pub const STORE_DIR: &str = ".polakapi";
/// The directory the terminal was opened in, exported by the PTY layer. The
/// store follows it rather than the process's cwd, which moves with every `cd`
/// the agent runs.
pub const PROJECT_DIR_ENV: &str = "POLAKAPI_PROJECT_DIR";
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
/// must start empty, and resuming a session — usually in a new terminal, whose
/// id is fresh — must bring its data back. So the key is the CLI session alone,
/// and the terminal only stands in when no session was recorded.
pub fn session_key(pty_id: &str, cli_session_id: Option<&str>) -> String {
    match cli_session_id {
        Some(session) if !session.is_empty() => session.to_string(),
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

/// The project a store belongs to: the terminal's directory when polakapi
/// exported one, otherwise wherever this process runs.
pub fn project_dir_from_env() -> Option<PathBuf> {
    project_dir(
        std::env::var_os(PROJECT_DIR_ENV),
        std::env::current_dir().ok(),
    )
}

fn project_dir(exported: Option<std::ffi::OsString>, cwd: Option<PathBuf>) -> Option<PathBuf> {
    exported
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or(cwd)
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

/// Serialises the processes writing one session. Kept outside the store itself,
/// which moves when it is promoted.
pub fn lock_file(session: &str) -> Option<PathBuf> {
    if !is_safe_session(session) {
        return None;
    }
    Some(
        std::env::temp_dir()
            .join("polakapi")
            .join("ctx-locks")
            .join(format!("{session}.lock")),
    )
}

/// Project operations take this lock before the session lock. Its generation
/// survives deletion of `.polakapi/ctx`, so cached connections cannot mistake a
/// newly created database for the one the user deleted.
pub struct ProjectLock {
    file: std::fs::File,
    pub generation: u64,
}

impl ProjectLock {
    pub fn acquire(project: &Path) -> Result<Self, String> {
        use sha2::{Digest, Sha256};
        use std::io::{Read, Seek, SeekFrom};
        let project = project
            .canonicalize()
            .map_err(|e| format!("project path: {e}"))?;
        let key = format!(
            "{:x}",
            Sha256::digest(project.as_os_str().as_encoded_bytes())
        );
        let root = std::env::temp_dir()
            .join("polakapi")
            .join("ctx-project-locks");
        std::fs::create_dir_all(&root).map_err(|e| format!("project lock directory: {e}"))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(key))
            .map_err(|e| format!("project lock: {e}"))?;
        file.lock().map_err(|e| format!("project lock: {e}"))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|e| format!("project generation: {e}"))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|e| format!("project generation: {e}"))?;
        let generation = if bytes.is_empty() {
            0
        } else {
            u64::from_le_bytes(bytes.try_into().map_err(|_| "invalid project generation")?)
        };
        Ok(Self { file, generation })
    }

    pub fn invalidate(&mut self) -> Result<(), String> {
        use std::io::{Seek, SeekFrom, Write};
        let next = self
            .generation
            .checked_add(1)
            .ok_or("project generation exhausted")?;
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|e| format!("project generation: {e}"))?;
        self.file
            .write_all(&next.to_le_bytes())
            .map_err(|e| format!("project generation: {e}"))?;
        self.file
            .sync_all()
            .map_err(|e| format!("project generation: {e}"))?;
        self.generation = next;
        Ok(())
    }
}

/// The session's store in the project: the existing directory, named or not,
/// or `<session>` when there is none yet.
pub fn project_store(project: &Path, session: &str) -> Option<PathBuf> {
    if !is_safe_session(session) {
        return None;
    }
    let root = project.join(STORE_DIR).join("ctx");
    Some(find_store(&root, session).unwrap_or_else(|| root.join(session)))
}

/// A named store is `<name>-<session>`, so it is found by its suffix. Legacy
/// `<terminal>-<session>` directories end the same way and are skipped: their
/// prefix is a terminal id, not a name.
fn find_store(root: &Path, session: &str) -> Option<PathBuf> {
    let exact = root.join(session);
    if exact.is_dir() {
        return Some(exact);
    }
    let suffix = format!("-{session}");
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .find(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(&suffix))
                .is_some_and(|prefix| !prefix.is_empty() && !is_uuid(prefix))
        })
        .map(|entry| entry.path())
}

fn is_uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The directory name for a session the user has named, e.g. after `/rename`.
pub fn store_dir_name(session: &str, title: Option<&str>) -> String {
    match title.map(slug).filter(|slug| !slug.is_empty()) {
        Some(slug) => format!("{slug}-{session}"),
        None => session.to_string(),
    }
}

fn slug(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.chars().count() >= 48 {
            break;
        }
    }
    slug.trim_end_matches('-').to_string()
}

/// Renames the session's project store to match its title. Returns the new
/// directory when it moved; a store that does not exist yet is left for the
/// next call, and a target that is taken is never overwritten.
pub fn rename_project_store(
    project: &Path,
    session: &str,
    title: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(current) = project_store(project, session) else {
        return Ok(None);
    };
    let Some(root) = current.parent() else {
        return Ok(None);
    };
    let target = root.join(store_dir_name(session, title));
    if target == current || !current.is_dir() || target.exists() {
        return Ok(None);
    }
    std::fs::rename(&current, &target)
        .map_err(|e| format!("could not rename {}: {e}", current.display()))?;
    Ok(Some(target))
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
    // Another process may still hold the old database open (Windows refuses to
    // delete it); the copy is already safe and the sweep clears the leftover.
    let _ = std::fs::remove_dir_all(from);
    Ok(())
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
    fn a_resumed_session_in_a_new_terminal_finds_its_store() {
        assert_eq!(
            session_key("pty-1", Some("session-a")),
            session_key("pty-2", Some("session-a"))
        );
    }

    #[test]
    fn the_exported_terminal_directory_wins_over_the_cwd() {
        let project = tempfile::tempdir().unwrap();
        let elsewhere = PathBuf::from("/somewhere/the/agent/cd-ed");
        assert_eq!(
            project_dir(Some(project.path().into()), Some(elsewhere.clone())),
            Some(project.path().to_path_buf())
        );
        assert_eq!(
            project_dir(Some("".into()), Some(elsewhere.clone())),
            Some(elsewhere.clone())
        );
        assert_eq!(
            project_dir(Some("/does/not/exist".into()), Some(elsewhere.clone())),
            Some(elsewhere)
        );
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

    const SESSION: &str = "e0eb2201-9526-477a-a0e3-ff127f62f0a0";

    fn store_root(project: &Path) -> PathBuf {
        project.join(STORE_DIR).join("ctx")
    }

    #[test]
    fn a_named_session_gets_a_readable_directory() {
        assert_eq!(
            store_dir_name(SESSION, Some("Ekim: NPC notes / sesión 3")),
            format!("ekim-npc-notes-sesión-3-{SESSION}")
        );
        assert_eq!(store_dir_name(SESSION, Some("  ")), SESSION);
        assert_eq!(store_dir_name(SESSION, None), SESSION);
    }

    #[test]
    fn a_renamed_store_is_still_found_by_its_session() {
        let project = tempfile::tempdir().unwrap();
        let named = store_root(project.path()).join(format!("ekim-{SESSION}"));
        std::fs::create_dir_all(&named).unwrap();
        assert_eq!(project_store(project.path(), SESSION), Some(named));
    }

    #[test]
    fn a_legacy_terminal_keyed_store_is_not_mistaken_for_a_name() {
        let project = tempfile::tempdir().unwrap();
        let legacy = store_root(project.path())
            .join(format!("28bba2ab-abaf-42d6-8aaf-c5ce681113ba-{SESSION}"));
        std::fs::create_dir_all(legacy).unwrap();
        assert_eq!(
            project_store(project.path(), SESSION),
            Some(store_root(project.path()).join(SESSION))
        );
    }

    #[test]
    fn renaming_follows_the_title_and_back() {
        let project = tempfile::tempdir().unwrap();
        let root = store_root(project.path());
        std::fs::create_dir_all(root.join(SESSION)).unwrap();

        let named = rename_project_store(project.path(), SESSION, Some("Ekim"))
            .unwrap()
            .unwrap();
        assert_eq!(named, root.join(format!("ekim-{SESSION}")));
        assert!(!root.join(SESSION).exists());

        let renamed = rename_project_store(project.path(), SESSION, Some("Ekim NPCs"))
            .unwrap()
            .unwrap();
        assert_eq!(renamed, root.join(format!("ekim-npcs-{SESSION}")));
        assert_eq!(
            rename_project_store(project.path(), SESSION, Some("Ekim NPCs")).unwrap(),
            None,
            "already named"
        );
    }

    #[test]
    fn renaming_a_store_that_does_not_exist_yet_does_nothing() {
        let project = tempfile::tempdir().unwrap();
        assert_eq!(
            rename_project_store(project.path(), SESSION, Some("Ekim")).unwrap(),
            None
        );
        assert!(!store_root(project.path()).exists());
    }
}
