use std::io::ErrorKind;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::blocking;
use super::branch::base_merge_base;
use super::git::git_stdout;
use super::paths::validate_path;
use crate::git_review::validate_repo_path;

pub(super) const MAX_CONTENT_BYTES: u64 = 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8000;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContentSource {
    Staged,
    Unstaged,
    Untracked,
    Branch { base: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SideContent {
    Text { text: String },
    Absent,
    Binary,
    TooLarge { bytes: u64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub before: SideContent,
    pub after: SideContent,
}

#[tauri::command]
pub async fn code_review_file_contents(
    project_path: String,
    path: String,
    original_path: Option<String>,
    source: ContentSource,
) -> Result<FileContents, String> {
    blocking(move || file_contents_sync(&project_path, &path, original_path.as_deref(), &source))
        .await
}

fn file_contents_sync(
    project_path: &str,
    path: &str,
    original_path: Option<&str>,
    source: &ContentSource,
) -> Result<FileContents, String> {
    let project = validate_repo_path(project_path)?;
    let path = validate_path(path)?;
    let before_path = match original_path {
        Some(original) => validate_path(original)?,
        None => path.clone(),
    };
    let (before, after) = match source {
        ContentSource::Staged => (
            object(&project, &format!("HEAD:{before_path}"))?,
            object(&project, &format!(":0:{path}"))?,
        ),
        ContentSource::Unstaged => {
            let index = object(&project, &format!(":0:{before_path}"))?;
            let before = match index {
                SideContent::Absent => object(&project, &format!("HEAD:{before_path}"))?,
                found => found,
            };
            (before, worktree(&project, &path)?)
        }
        ContentSource::Untracked => (SideContent::Absent, worktree(&project, &path)?),
        ContentSource::Branch { base } => {
            let merge_base = base_merge_base(&project, base)?;
            (
                object(&project, &format!("{merge_base}:{before_path}"))?,
                object(&project, &format!("HEAD:{path}"))?,
            )
        }
    };
    Ok(FileContents { before, after })
}

fn object(project: &Path, spec: &str) -> Result<SideContent, String> {
    let Ok(raw_size) = git_stdout(project, &["cat-file", "-s", spec]) else {
        return Ok(SideContent::Absent);
    };
    let bytes = String::from_utf8_lossy(&raw_size)
        .trim()
        .parse::<u64>()
        .map_err(|error| format!("unexpected object size for {spec}: {error}"))?;
    if bytes > MAX_CONTENT_BYTES {
        return Ok(SideContent::TooLarge { bytes });
    }
    Ok(classify(git_stdout(project, &["cat-file", "blob", spec])?))
}

fn worktree(project: &Path, relative: &str) -> Result<SideContent, String> {
    let target = project.join(relative);
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(SideContent::Absent),
        Err(error) => return Err(format!("could not read {relative}: {error}")),
    };
    ensure_inside(project, &target, relative, meta.file_type().is_symlink())?;
    if meta.file_type().is_symlink() {
        let link = std::fs::read_link(&target)
            .map_err(|error| format!("could not read link {relative}: {error}"))?;
        return Ok(SideContent::Text {
            text: link.to_string_lossy().into_owned(),
        });
    }
    if !meta.is_file() {
        return Ok(SideContent::Absent);
    }
    if meta.len() > MAX_CONTENT_BYTES {
        return Ok(SideContent::TooLarge { bytes: meta.len() });
    }
    std::fs::read(&target)
        .map(classify)
        .map_err(|error| format!("could not read {relative}: {error}"))
}

fn ensure_inside(
    project: &Path,
    target: &Path,
    relative: &str,
    is_link: bool,
) -> Result<(), String> {
    let resolved = if is_link {
        target.parent().map(Path::to_path_buf).unwrap_or_default()
    } else {
        target.to_path_buf()
    };
    let canonical = |path: &Path| {
        std::fs::canonicalize(path)
            .map_err(|error| format!("could not resolve {relative}: {error}"))
    };
    if canonical(&resolved)?.starts_with(canonical(project)?) {
        Ok(())
    } else {
        Err(format!("path is outside the project: {relative}"))
    }
}

fn classify(content: Vec<u8>) -> SideContent {
    let sniff = &content[..content.len().min(BINARY_SNIFF_BYTES)];
    if sniff.contains(&0) {
        return SideContent::Binary;
    }
    match String::from_utf8(content) {
        Ok(text) => SideContent::Text { text },
        Err(_) => SideContent::Binary,
    }
}

#[cfg(test)]
mod tests;
