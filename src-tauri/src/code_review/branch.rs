use std::path::Path;

use serde::Serialize;

use super::blocking;
use super::changes::parse::parse_numstat_z;
use super::changes::ChangeStatus;
use super::git::{git_stdout, lossy, nul_records};
use crate::git_review::{
    is_safe_git_ref, merge_base, ref_exists, rev_parse_verify, validate_repo_path,
};

const DEFAULT_BASES: [(&str, &str); 4] = [
    ("refs/heads/main", "main"),
    ("refs/heads/master", "master"),
    ("refs/remotes/origin/main", "origin/main"),
    ("refs/remotes/origin/master", "origin/master"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: ChangeStatus,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchOverview {
    pub base: String,
    pub merge_base: String,
    pub files: Vec<BranchFile>,
}

#[tauri::command]
pub async fn code_review_default_base(project_path: String) -> Result<Option<String>, String> {
    blocking(move || default_base_sync(&project_path)).await
}

#[tauri::command]
pub async fn code_review_branch(
    project_path: String,
    base: String,
) -> Result<BranchOverview, String> {
    blocking(move || branch_overview_sync(&project_path, &base)).await
}

fn default_base_sync(project_path: &str) -> Result<Option<String>, String> {
    let project = validate_repo_path(project_path)?;
    for (full_ref, name) in DEFAULT_BASES {
        if ref_exists(&project, full_ref)? {
            return Ok(Some(name.to_string()));
        }
    }
    Ok(None)
}

pub(super) fn base_merge_base(project: &Path, base: &str) -> Result<String, String> {
    if !is_safe_git_ref(base) {
        return Err(format!("invalid base branch: {base:?}"));
    }
    let base_sha = rev_parse_verify(project, base)?;
    merge_base(project, &base_sha, "HEAD")
}

fn branch_overview_sync(project_path: &str, base: &str) -> Result<BranchOverview, String> {
    let project = validate_repo_path(project_path)?;
    let merge_base = base_merge_base(&project, base)?;
    let range = [merge_base.as_str(), "HEAD"];
    let names = git_stdout(
        &project,
        &[&["diff", "--name-status", "-z", "-M"][..], &range].concat(),
    )?;
    let counts = parse_numstat_z(&git_stdout(
        &project,
        &[&["diff", "--numstat", "-z", "-M"][..], &range].concat(),
    )?);
    let files = parse_name_status_z(&names)
        .into_iter()
        .map(|entry| {
            let counts = counts.get(&entry.path).copied().unwrap_or_default();
            BranchFile {
                path: entry.path,
                original_path: entry.original_path,
                status: entry.status,
                insertions: counts.insertions,
                deletions: counts.deletions,
                binary: counts.binary,
            }
        })
        .collect();
    Ok(BranchOverview {
        base: base.to_string(),
        merge_base,
        files,
    })
}

struct NameStatus {
    status: ChangeStatus,
    path: String,
    original_path: Option<String>,
}

fn parse_name_status_z(raw: &[u8]) -> Vec<NameStatus> {
    let mut records = nul_records(raw);
    let mut entries = Vec::new();
    while let Some(code) = records.next() {
        let Some(first) = records.next().map(lossy) else {
            break;
        };
        let (status, path, original_path) = match code.first() {
            Some(b'R') => match records.next().map(lossy) {
                Some(path) => (ChangeStatus::Renamed, path, Some(first)),
                None => break,
            },
            Some(b'C') => match records.next().map(lossy) {
                Some(path) => (ChangeStatus::Added, path, None),
                None => break,
            },
            Some(b'A') => (ChangeStatus::Added, first, None),
            Some(b'D') => (ChangeStatus::Deleted, first, None),
            Some(b'U') => (ChangeStatus::Conflicted, first, None),
            _ => (ChangeStatus::Modified, first, None),
        };
        entries.push(NameStatus {
            status,
            path,
            original_path,
        });
    }
    entries
}

#[cfg(test)]
mod tests;
