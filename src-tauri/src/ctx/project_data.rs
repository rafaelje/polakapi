use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::ctx::paths::STORE_DIR;

// Lets the user delete the context mode data persisted inside one project.
//
// Only `<project>/.polakapi/ctx` is removed. Existing `.gitignore` files have
// no ownership marker, so they are always preserved. Symbolic links are never
// followed: a link planted at either path would otherwise let this delete
// something outside the project.

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectData {
    /// Stored sessions, one directory each.
    pub sessions: u64,
    pub bytes: u64,
}

#[tauri::command]
pub fn ctx_project_data_summary(project_path: String) -> Result<ProjectData, String> {
    summary(&project_dir(&project_path)?)
}

#[tauri::command]
pub fn ctx_clear_project_data(project_path: String) -> Result<ProjectData, String> {
    clear(&project_dir(&project_path)?)
}

fn project_dir(project_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(project_path);
    if !path.is_absolute() {
        return Err(format!("not an absolute project path: {project_path}"));
    }
    if !path.is_dir() {
        return Err(format!("project folder not found: {project_path}"));
    }
    Ok(path)
}

/// Returns the directory only when it is a real directory, not a link.
fn real_dir(path: &Path) -> Option<&Path> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    (meta.file_type().is_dir()).then_some(path)
}

pub fn summary(project: &Path) -> Result<ProjectData, String> {
    let root = project.join(STORE_DIR);
    let store = root.join("ctx");
    if real_dir(&root).is_none() || real_dir(&store).is_none() {
        return Ok(ProjectData::default());
    }
    let mut data = ProjectData::default();
    let entries = std::fs::read_dir(&store)
        .map_err(|e| format!("could not read {}: {e}", store.display()))?;
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            data.sessions += 1;
            data.bytes = data.bytes.saturating_add(dir_size(&entry.path()));
        }
    }
    Ok(data)
}

pub fn clear(project: &Path) -> Result<ProjectData, String> {
    let mut lifecycle = crate::ctx::paths::ProjectLock::acquire(project)?;
    let removed = summary(project)?;
    let root = project.join(STORE_DIR);
    let Some(store) = real_dir(&root.join("ctx")).map(Path::to_path_buf) else {
        return Ok(ProjectData::default());
    };
    if real_dir(&root).is_none() {
        return Ok(ProjectData::default());
    }
    // Invalidate before removal: even a partially failed removal must not leave
    // a cached connection serving content from an unlinked database.
    lifecycle.invalidate()?;
    std::fs::remove_dir_all(&store)
        .map_err(|e| format!("could not delete {}: {e}", store.display()))?;

    // Only remove an actually empty directory; never infer file ownership.
    let _ = std::fs::remove_dir(&root);
    Ok(removed)
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => dir_size(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            _ => 0,
        })
        .fold(0u64, u64::saturating_add)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_session(project: &Path, name: &str, bytes: usize) {
        let dir = project.join(STORE_DIR).join("ctx").join(name);
        std::fs::create_dir_all(dir.join("artifacts")).unwrap();
        std::fs::write(dir.join("ctx.db"), vec![0u8; bytes]).unwrap();
        std::fs::write(project.join(STORE_DIR).join(".gitignore"), "*\n").unwrap();
    }

    #[test]
    fn summarises_what_would_be_deleted() {
        let project = tempfile::tempdir().unwrap();
        store_session(project.path(), "one", 100);
        store_session(project.path(), "two", 50);
        assert_eq!(
            summary(project.path()).unwrap(),
            ProjectData {
                sessions: 2,
                bytes: 150
            }
        );
    }

    #[test]
    fn clearing_removes_context_data_but_preserves_the_ignore() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("main.rs"), "fn main() {}").unwrap();
        store_session(project.path(), "one", 10);

        let removed = clear(project.path()).unwrap();
        assert_eq!(removed.sessions, 1);
        assert!(!project.path().join(STORE_DIR).join("ctx").exists());
        assert!(project.path().join(STORE_DIR).join(".gitignore").is_file());
        // The user's own files are untouched.
        assert_eq!(
            std::fs::read_to_string(project.path().join("main.rs")).unwrap(),
            "fn main() {}"
        );
    }

    #[test]
    fn clear_waits_for_an_inflight_project_operation() {
        let project = tempfile::tempdir().unwrap();
        store_session(project.path(), "one", 10);
        let guard = crate::ctx::paths::ProjectLock::acquire(project.path()).unwrap();
        let path = project.path().to_path_buf();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = clear(&path);
            done_tx.send(result).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(matches!(
            done_rx.recv_timeout(std::time::Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert!(project.path().join(STORE_DIR).join("ctx").exists());
        drop(guard);
        assert_eq!(
            done_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap()
                .sessions,
            1
        );
        worker.join().unwrap();
        assert!(!project.path().join(STORE_DIR).join("ctx").exists());
    }

    #[test]
    fn clearing_preserves_a_preexisting_ignore_even_when_it_is_the_only_file() {
        let project = tempfile::tempdir().unwrap();
        store_session(project.path(), "one", 10);
        let ignore = project.path().join(STORE_DIR).join(".gitignore");
        std::fs::write(&ignore, "user-custom-ignore\n").unwrap();
        clear(project.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(ignore).unwrap(),
            "user-custom-ignore\n"
        );
    }

    #[test]
    fn keeps_anything_else_the_user_put_in_the_folder() {
        let project = tempfile::tempdir().unwrap();
        store_session(project.path(), "one", 10);
        std::fs::write(project.path().join(STORE_DIR).join("notes.md"), "mine").unwrap();

        clear(project.path()).unwrap();
        assert!(!project.path().join(STORE_DIR).join("ctx").exists());
        assert!(project.path().join(STORE_DIR).join("notes.md").is_file());
    }

    #[test]
    fn a_project_without_data_is_a_no_op() {
        let project = tempfile::tempdir().unwrap();
        assert_eq!(clear(project.path()).unwrap(), ProjectData::default());
        assert!(!project.path().join(STORE_DIR).exists());
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_link_out_of_the_project() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("precious.txt"), "keep me").unwrap();
        std::fs::create_dir_all(project.path().join(STORE_DIR)).unwrap();
        std::os::unix::fs::symlink(outside.path(), project.path().join(STORE_DIR).join("ctx"))
            .unwrap();

        assert_eq!(summary(project.path()).unwrap(), ProjectData::default());
        clear(project.path()).unwrap();
        assert!(outside.path().join("precious.txt").is_file());
    }

    #[test]
    fn rejects_paths_that_are_not_real_project_folders() {
        assert!(project_dir("relative/path").is_err());
        assert!(project_dir("/definitely/not/a/folder/here").is_err());
    }
}
