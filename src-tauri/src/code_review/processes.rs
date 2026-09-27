use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::Serialize;

use super::review_folder::review_folder;
use crate::git_review::validate_repo_path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewProcess {
    pub number: String,
    pub slug: String,
    pub markdown: Option<String>,
    pub html: Option<String>,
    pub verdict: Verdict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewProcesses {
    pub branch: String,
    pub folder: String,
    pub processes: Vec<ReviewProcess>,
}

enum ProcessFile {
    Markdown,
    Html,
}

struct ProcessName {
    order: Vec<u32>,
    number: String,
    slug: String,
    kind: ProcessFile,
}

#[tauri::command]
pub async fn code_review_processes(project_path: String) -> Result<ReviewProcesses, String> {
    tokio::task::spawn_blocking(move || processes_sync(&project_path))
        .await
        .map_err(|error| format!("join error: {error}"))?
}

fn processes_sync(project_path: &str) -> Result<ReviewProcesses, String> {
    let project = validate_repo_path(project_path)?;
    let folder = review_folder(&project)?;
    let processes = list_processes(&project.join(&folder.folder))?;
    Ok(ReviewProcesses {
        branch: folder.branch,
        folder: folder.folder,
        processes,
    })
}

fn list_processes(dir: &Path) -> Result<Vec<ReviewProcess>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("could not list the review folder: {error}")),
    };
    let mut grouped: BTreeMap<(Vec<u32>, String), ReviewProcess> = BTreeMap::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let Some(name) = parse_process_name(&file_name) else {
            continue;
        };
        let process = grouped
            .entry((name.order, name.slug.clone()))
            .or_insert_with(|| ReviewProcess {
                number: name.number,
                slug: name.slug,
                markdown: None,
                html: None,
                verdict: Verdict::Pending,
            });
        match name.kind {
            ProcessFile::Markdown => process.markdown = Some(file_name),
            ProcessFile::Html => process.html = Some(file_name),
        }
    }
    Ok(grouped.into_values().collect())
}

fn parse_process_name(file_name: &str) -> Option<ProcessName> {
    let (stem, extension) = file_name.rsplit_once('.')?;
    let kind = match extension.to_ascii_lowercase().as_str() {
        "md" => ProcessFile::Markdown,
        "html" => ProcessFile::Html,
        _ => return None,
    };
    let (number, slug) = stem.split_once('-')?;
    let order = number
        .split('.')
        .map(|part| {
            let digits = !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
            digits.then(|| part.parse::<u32>().ok()).flatten()
        })
        .collect::<Option<Vec<u32>>>()?;
    if slug.is_empty() {
        return None;
    }
    Some(ProcessName {
        order,
        number: number.to_string(),
        slug: slug.to_string(),
        kind,
    })
}

#[cfg(test)]
mod tests;
