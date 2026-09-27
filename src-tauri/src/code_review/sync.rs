use std::path::Path;

use super::blocking;
use super::git::{git_stdout, git_unattended};
use super::refs::{current_branch_name, list_branch_refs};
use crate::git_review::{is_safe_git_ref, ref_exists, validate_repo_path};

#[tauri::command]
pub async fn code_review_pull(project_path: String) -> Result<String, String> {
    blocking(move || pull_sync(&project_path)).await
}

#[tauri::command]
pub async fn code_review_switch_branch(
    project_path: String,
    branch: String,
) -> Result<String, String> {
    blocking(move || switch_branch_sync(&project_path, &branch)).await
}

fn pull_sync(project_path: &str) -> Result<String, String> {
    let project = validate_repo_path(project_path)?;
    let Some(branch) = current_branch_name(&project) else {
        return Err("Cannot pull: HEAD is detached, switch to a branch first.".into());
    };
    let upstream = git_unattended(&project, &["rev-parse", "--abbrev-ref", "@{upstream}"])?;
    if !upstream.status.success() {
        return Err(format!(
            "Cannot pull: {branch} has no upstream branch to pull from."
        ));
    }
    let output = git_unattended(&project, &["pull", "--ff-only", "--no-rebase"])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.to_lowercase().contains("fast-forward") {
            return Err(format!(
                "Pull refused: {branch} has diverged from its upstream and cannot be fast-forwarded. polakapi only pulls with --ff-only, so merge or rebase it yourself."
            ));
        }
        return Err(format!("git pull failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("Pulled.")
        .to_string())
}

fn switch_branch_sync(project_path: &str, branch: &str) -> Result<String, String> {
    if !is_safe_git_ref(branch) {
        return Err(format!("invalid branch name: {branch:?}"));
    }
    let project = validate_repo_path(project_path)?;
    let target = resolve_switch_target(&project, branch)?;
    let changes = git_stdout(
        &project,
        &["status", "--porcelain", "--untracked-files=all"],
    )?;
    let dirty = String::from_utf8_lossy(&changes).lines().count();
    if dirty > 0 {
        return Err(format!(
            "Cannot switch branches: the working tree has {dirty} uncommitted changes. Commit or discard them first."
        ));
    }
    match &target {
        SwitchTarget::Local(name) => git_stdout(&project, &["switch", "-q", name])?,
        SwitchTarget::Track(remote) => git_stdout(&project, &["switch", "-q", "--track", remote])?,
    };
    current_branch_name(&project).ok_or_else(|| "switched, but HEAD is detached".to_string())
}

enum SwitchTarget {
    Local(String),
    Track(String),
}

fn resolve_switch_target(project: &Path, branch: &str) -> Result<SwitchTarget, String> {
    if ref_exists(project, &format!("refs/heads/{branch}"))? {
        return Ok(SwitchTarget::Local(branch.to_string()));
    }
    let refs = list_branch_refs(project)?;
    let remote = refs
        .remote
        .into_iter()
        .find(|remote| remote.name == branch)
        .ok_or_else(|| format!("unknown branch: {branch}"))?;
    if refs.local.contains(&remote.branch) {
        return Ok(SwitchTarget::Local(remote.branch));
    }
    Ok(SwitchTarget::Track(remote.name))
}

#[cfg(test)]
mod tests;
