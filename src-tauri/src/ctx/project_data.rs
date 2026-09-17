use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::ctx::paths::STORE_DIR;

// Lets the user delete the context mode data persisted inside one project.
//
// Only `<project>/.polakapi/ctx` is ever removed. The `.polakapi` folder goes
// too when nothing but its own `.gitignore` is left, so a cleared project ends up
// exactly as it was before context mode wrote to it. Symbolic links are never
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
    let removed = summary(project)?;
    let root = project.join(STORE_DIR);
    let Some(store) = real_dir(&root.join("ctx")).map(Path::to_path_buf) else {
        return Ok(ProjectData::default());
    };
    if real_dir(&root).is_none() {
        return Ok(ProjectData::default());
    }
    std::fs::remove_dir_all(&store)
        .map_err(|e| format!("could not delete {}: {e}", store.display()))?;

    // Leave no trace when context mode was the only thing in `.polakapi`.
    let only_own_ignore = std::fs::read_dir(&root)
        .map(|entries| {
            entries
                .flatten()
                .all(|entry| entry.file_name() == ".gitignore")
        })
        .unwrap_or(false);
    if only_own_ignore {
        let _ = std::fs::remove_dir_all(&root);
    }
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
    fn clearing_leaves_the_project_as_it_was_before_context_mode() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("main.rs"), "fn main() {}").unwrap();
        store_session(project.path(), "one", 10);

        let removed = clear(project.path()).unwrap();
        assert_eq!(removed.sessions, 1);
        assert!(!project.path().join(STORE_DIR).exists());
        // The user's own files are untouched.
        assert_eq!(
            std::fs::read_to_string(project.path().join("main.rs")).unwrap(),
            "fn main() {}"
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
