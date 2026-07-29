//! Creates a git worktree for a new branch off the project's detected base ref.
//! Lands as an automatic sibling directory next to the repo.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::git_review::{detect_base_ref_sync, validate_repo_path};

#[tauri::command]
pub async fn git_create_worktree(project_path: String, branch: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || create_worktree_sync(&project_path, &branch))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn create_worktree_sync(project_path: &str, branch: &str) -> Result<String, String> {
    let project = validate_repo_path(project_path)?;
    let project = project
        .canonicalize()
        .map_err(|e| format!("could not canonicalize project: {e}"))?;

    let branch = branch.trim();
    if !is_valid_new_branch_name(branch) {
        return Err(format!("invalid branch name: {branch}"));
    }

    let base_ref = detect_base_ref_sync(project_path)?;
    let worktree_path = sibling_worktree_path(&project, branch)?;

    if worktree_path.exists() {
        return Err(format!(
            "a worktree directory already exists at {}",
            worktree_path.display()
        ));
    }

    let worktrees_root = worktree_path
        .parent()
        .ok_or_else(|| "could not determine worktrees root".to_string())?;
    std::fs::create_dir_all(worktrees_root)
        .map_err(|e| format!("could not create {}: {e}", worktrees_root.display()))?;

    let worktree_path_str = worktree_path.to_string_lossy().to_string();
    let output = Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            branch,
            &worktree_path_str,
            &base_ref,
        ])
        .current_dir(&project)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git worktree add: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(worktree_path_str)
}

/// `<parent-of-repo>/<repo-dir-name>-worktrees/<branch>`, `/` flattened to `-`
/// so branches like `feature` and `feature/foo` can't collide on disk.
fn sibling_worktree_path(project: &std::path::Path, branch: &str) -> Result<PathBuf, String> {
    let repo_dir_name = project
        .file_name()
        .ok_or_else(|| "could not determine repo directory name".to_string())?
        .to_string_lossy()
        .to_string();
    let parent = project
        .parent()
        .ok_or_else(|| "project has no parent directory".to_string())?;
    let worktree_dir_name = branch.replace('/', "-");
    Ok(parent
        .join(format!("{repo_dir_name}-worktrees"))
        .join(worktree_dir_name))
}

/// Stricter than `is_safe_git_ref`: validates a *new* branch name, so
/// ref-relative syntax is dropped and filesystem hygiene is enforced.
fn is_valid_new_branch_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 200 {
        return false;
    }
    if name.starts_with('-') || name.starts_with('/') || name.ends_with('/') {
        return false;
    }
    if name.contains("//") || name.contains("..") || name.contains(':') {
        return false;
    }
    if name.chars().any(char::is_whitespace) {
        return false;
    }
    if name.ends_with(".lock") || name.ends_with('.') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
}

#[cfg(test)]
mod tests;
