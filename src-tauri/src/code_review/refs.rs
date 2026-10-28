use std::path::Path;

use serde::Serialize;

use super::blocking;
use super::git::{git_stdout, trimmed};
use crate::git_review::validate_repo_path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    pub name: String,
    pub remote: String,
    pub branch: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRefs {
    pub current: Option<String>,
    pub local: Vec<String>,
    pub remote: Vec<RemoteBranch>,
}

#[tauri::command]
pub async fn code_review_refs(project_path: String) -> Result<BranchRefs, String> {
    blocking(move || branch_refs_sync(&project_path)).await
}

fn branch_refs_sync(project_path: &str) -> Result<BranchRefs, String> {
    let project = validate_repo_path(project_path)?;
    list_branch_refs(&project)
}

pub(crate) fn list_branch_refs(project: &Path) -> Result<BranchRefs, String> {
    let remotes = lines(&git_stdout(project, &["remote"])?);
    let listing = git_stdout(
        project,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(symref)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut refs = BranchRefs {
        current: current_branch_name(project),
        ..BranchRefs::default()
    };
    for line in lines(&listing) {
        let (refname, symref) = line.split_once('\0').unwrap_or((line.as_str(), ""));
        if !symref.is_empty() {
            continue;
        }
        if let Some(local) = refname.strip_prefix("refs/heads/") {
            refs.local.push(local.to_string());
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            if let Some(branch) = split_remote(name, &remotes) {
                refs.remote.push(branch);
            }
        }
    }
    Ok(refs)
}

pub(crate) fn current_branch_name(project: &Path) -> Option<String> {
    let raw = git_stdout(project, &["symbolic-ref", "--short", "-q", "HEAD"]).ok()?;
    let name = trimmed(&raw);
    (!name.is_empty()).then_some(name)
}

fn split_remote(name: &str, remotes: &[String]) -> Option<RemoteBranch> {
    remotes
        .iter()
        .filter_map(|remote| {
            let branch = name.strip_prefix(remote.as_str())?.strip_prefix('/')?;
            (!branch.is_empty()).then(|| RemoteBranch {
                name: name.to_string(),
                remote: remote.clone(),
                branch: branch.to_string(),
            })
        })
        .max_by_key(|branch| branch.remote.len())
}

fn lines(raw: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(raw)
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests;
