use std::path::Path;

use super::blocking;
use super::git::{git_read, git_stdout, git_with_stdin, lossy, trimmed};
use crate::git_review::validate_repo_path;

#[tauri::command]
pub async fn code_review_commit(project_path: String, message: String) -> Result<String, String> {
    blocking(move || commit_sync(&project_path, &message)).await
}

fn commit_sync(project_path: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("the commit message is empty".into());
    }
    let project = validate_repo_path(project_path)?;
    if !has_staged_changes(&project)? {
        return Err("nothing is staged to commit".into());
    }
    run_commit(&project, message)?;
    let hash = git_stdout(&project, &["rev-parse", "--short", "HEAD"])?;
    Ok(trimmed(&hash))
}

fn has_staged_changes(project: &Path) -> Result<bool, String> {
    let output = git_read(project, &["diff", "--cached", "--quiet"])?;
    match output.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(format!("git diff failed: {}", trimmed(&output.stderr))),
    }
}

fn run_commit(project: &Path, message: &str) -> Result<(), String> {
    let output = git_with_stdin(project, &["commit", "-q", "-F", "-"], message.as_bytes())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = lossy(&output.stderr);
    let stdout = lossy(&output.stdout);
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!("git commit failed: {detail}"))
}

#[cfg(test)]
mod tests;
