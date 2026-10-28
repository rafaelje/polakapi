use super::blocking;
use super::git::{git_stdout, git_with_pathspec, has_head};
use super::paths::literal_pathspec;
use crate::git_review::validate_repo_path;

#[tauri::command]
pub async fn code_review_stage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || stage_sync(&project_path, &paths)).await
}

#[tauri::command]
pub async fn code_review_unstage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || unstage_sync(&project_path, &paths)).await
}

#[tauri::command]
pub async fn code_review_stage_all(project_path: String) -> Result<(), String> {
    blocking(move || stage_all_sync(&project_path)).await
}

fn stage_sync(project_path: &str, paths: &[String]) -> Result<(), String> {
    let project = validate_repo_path(project_path)?;
    let spec = literal_pathspec(paths)?;
    git_with_pathspec(&project, &["add", "-A"], &spec).map(|_| ())
}

fn unstage_sync(project_path: &str, paths: &[String]) -> Result<(), String> {
    let project = validate_repo_path(project_path)?;
    let spec = literal_pathspec(paths)?;
    let command: &[&str] = if has_head(&project) {
        &["restore", "--staged"]
    } else {
        &["rm", "--cached", "-q", "-r"]
    };
    git_with_pathspec(&project, command, &spec).map(|_| ())
}

fn stage_all_sync(project_path: &str) -> Result<(), String> {
    let project = validate_repo_path(project_path)?;
    git_stdout(&project, &["add", "-A"]).map(|_| ())
}

#[cfg(test)]
mod tests;
