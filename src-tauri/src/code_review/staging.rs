use std::path::Path;

use super::git::git_stdout;
use super::paths::pathspec;
use crate::git_review::validate_repo_path;

#[tauri::command]
pub async fn code_review_stage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    run_blocking(move || stage_sync(&project_path, &paths)).await
}

#[tauri::command]
pub async fn code_review_unstage(project_path: String, paths: Vec<String>) -> Result<(), String> {
    run_blocking(move || unstage_sync(&project_path, &paths)).await
}

#[tauri::command]
pub async fn code_review_stage_all(project_path: String) -> Result<(), String> {
    run_blocking(move || stage_all_sync(&project_path)).await
}

async fn run_blocking(
    job: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|error| format!("join error: {error}"))?
}

fn stage_sync(project_path: &str, paths: &[String]) -> Result<(), String> {
    let project = validate_repo_path(project_path)?;
    let spec = literal_pathspec(paths)?;
    run_git(&project, &["add", "-A"], &spec)
}

fn unstage_sync(project_path: &str, paths: &[String]) -> Result<(), String> {
    let project = validate_repo_path(project_path)?;
    let spec = literal_pathspec(paths)?;
    if has_head(&project) {
        run_git(&project, &["restore", "--staged"], &spec)
    } else {
        run_git(&project, &["rm", "--cached", "-q", "-r"], &spec)
    }
}

fn stage_all_sync(project_path: &str) -> Result<(), String> {
    let project = validate_repo_path(project_path)?;
    git_stdout(&project, &["add", "-A"]).map(|_| ())
}

fn literal_pathspec(paths: &[String]) -> Result<Vec<String>, String> {
    let mut spec = pathspec(paths)?;
    for path in spec.iter_mut().skip(1) {
        *path = format!(":(literal){path}");
    }
    Ok(spec)
}

fn has_head(project: &Path) -> bool {
    git_stdout(project, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

fn run_git(project: &Path, command: &[&str], spec: &[String]) -> Result<(), String> {
    let mut args: Vec<&str> = command.to_vec();
    args.extend(spec.iter().map(String::as_str));
    git_stdout(project, &args).map(|_| ())
}

#[cfg(test)]
mod tests;
