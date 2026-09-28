use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;

use super::blocking;
use super::refs::current_branch_name;
use crate::git_review::validate_repo_path;

pub(super) const REVIEW_ROOT: &str = "docs/code-review";
const IGNORE_ALL: &str = "*";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFolder {
    pub branch: String,
    pub folder: String,
}

#[tauri::command]
pub async fn code_review_prepare_review(
    project_path: String,
    clear: bool,
) -> Result<ReviewFolder, String> {
    blocking(move || prepare_sync(&project_path, clear)).await
}

fn prepare_sync(project_path: &str, clear: bool) -> Result<ReviewFolder, String> {
    let project = validate_repo_path(project_path)?;
    let folder = review_folder(&project)?;
    let root = project.join(REVIEW_ROOT);
    fs::create_dir_all(&root).map_err(|error| io_error(REVIEW_ROOT, error))?;
    ensure_gitignore(&root)?;
    let dir = project.join(&folder.folder);
    if clear && dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| io_error(&folder.folder, error))?;
    }
    fs::create_dir_all(&dir).map_err(|error| io_error(&folder.folder, error))?;
    Ok(folder)
}

pub(super) fn review_folder(project: &Path) -> Result<ReviewFolder, String> {
    let branch = current_branch_name(project)
        .ok_or_else(|| "HEAD is detached: switch to a branch to run a review".to_string())?;
    Ok(ReviewFolder {
        folder: format!("{REVIEW_ROOT}/{}", branch_folder_name(&branch)),
        branch,
    })
}

/// `~` cannot appear in a branch name, so mapping `/` to it keeps every
/// branch in its own folder.
pub(super) fn branch_folder_name(branch: &str) -> String {
    branch.replace('/', "~")
}

fn ensure_gitignore(root: &Path) -> Result<(), String> {
    let path = root.join(".gitignore");
    let label = format!("{REVIEW_ROOT}/.gitignore");
    let next = match fs::read_to_string(&path) {
        Ok(content) if content.lines().any(|line| line.trim() == IGNORE_ALL) => return Ok(()),
        Ok(content) if content.is_empty() || content.ends_with('\n') => {
            format!("{content}{IGNORE_ALL}\n")
        }
        Ok(content) => format!("{content}\n{IGNORE_ALL}\n"),
        Err(error) if error.kind() == ErrorKind::NotFound => format!("{IGNORE_ALL}\n"),
        Err(error) => return Err(io_error(&label, error)),
    };
    fs::write(&path, next).map_err(|error| io_error(&label, error))
}

fn io_error(path: &str, error: std::io::Error) -> String {
    format!("could not prepare {path}: {error}")
}

#[cfg(test)]
mod tests;
