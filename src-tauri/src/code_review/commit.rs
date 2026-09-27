use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use super::git::git_stdout;
use crate::git_review::validate_repo_path;

#[tauri::command]
pub async fn code_review_commit(project_path: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || commit_sync(&project_path, &message))
        .await
        .map_err(|error| format!("join error: {error}"))?
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
    Ok(String::from_utf8_lossy(&hash).trim().to_string())
}

fn has_staged_changes(project: &Path) -> Result<bool, String> {
    let output = Command::new("git")
        .args(["--no-optional-locks", "diff", "--cached", "--quiet"])
        .current_dir(project)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("could not run git: {error}"))?;
    match output.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )),
    }
}

fn run_commit(project: &Path, message: &str) -> Result<(), String> {
    let mut child = Command::new("git")
        .args(["commit", "-q", "-F", "-"])
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not run git: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(message.as_bytes())
            .map_err(|error| format!("could not pass the commit message: {error}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("could not run git: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!("git commit failed: {detail}"))
}

#[cfg(test)]
mod tests;
