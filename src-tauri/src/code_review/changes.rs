use std::path::Path;

use serde::Serialize;

use super::blocking;
use super::git::git_stdout;
use super::refs::current_branch_name;
use crate::git_review::{current_branch, validate_repo_path};
use parse::{count_text_lines, parse_numstat_z, parse_porcelain_z, LineCounts};

pub(super) mod parse;

const MAX_COUNTED_UNTRACKED_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeGroup {
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub original_path: Option<String>,
    pub group: ChangeGroup,
    pub status: ChangeStatus,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesOverview {
    pub branch: Option<String>,
    pub files: Vec<ChangedFile>,
}

#[tauri::command]
pub async fn code_review_changes(project_path: String) -> Result<ChangesOverview, String> {
    blocking(move || changes_overview_sync(&project_path)).await
}

fn changes_overview_sync(project_path: &str) -> Result<ChangesOverview, String> {
    let project = validate_repo_path(project_path)?;
    let status = git_stdout(
        &project,
        &[
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--renames",
        ],
    )?;
    let staged = parse_numstat_z(&git_stdout(
        &project,
        &["diff", "--cached", "--numstat", "-z", "-M"],
    )?);
    let unstaged = parse_numstat_z(&git_stdout(&project, &["diff", "--numstat", "-z"])?);

    let files = parse_porcelain_z(&status)
        .into_iter()
        .map(|entry| {
            let counts = match entry.group {
                ChangeGroup::Staged => staged.get(&entry.path).copied(),
                ChangeGroup::Unstaged => unstaged.get(&entry.path).copied(),
                ChangeGroup::Untracked => Some(untracked_counts(&project, &entry.path)),
            }
            .unwrap_or_default();
            ChangedFile {
                path: entry.path,
                original_path: entry.original_path,
                group: entry.group,
                status: entry.status,
                insertions: counts.insertions,
                deletions: counts.deletions,
                binary: counts.binary,
            }
        })
        .collect();

    Ok(ChangesOverview {
        branch: current_branch(&project)
            .ok()
            .or_else(|| current_branch_name(&project)),
        files,
    })
}

fn untracked_counts(project: &Path, relative: &str) -> LineCounts {
    let target = project.join(relative);
    let is_small_file = std::fs::symlink_metadata(&target)
        .is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_COUNTED_UNTRACKED_BYTES);
    if !is_small_file {
        return LineCounts::default();
    }
    std::fs::read(&target)
        .map(|content| count_text_lines(&content))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
