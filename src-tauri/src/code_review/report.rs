use std::fs;
use std::io::Read;

use super::review_folder::review_folder;
use crate::git_review::validate_repo_path;

pub(super) const MAX_REPORT_BYTES: u64 = 4 * 1024 * 1024;

#[tauri::command]
pub async fn code_review_process_report(
    project_path: String,
    file: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || report_sync(&project_path, &file))
        .await
        .map_err(|error| format!("join error: {error}"))?
}

fn report_sync(project_path: &str, file: &str) -> Result<String, String> {
    validate_report_name(file)?;
    let project = validate_repo_path(project_path)?;
    let folder = review_folder(&project)?;
    let dir = project
        .join(&folder.folder)
        .canonicalize()
        .map_err(|error| format!("could not open {}: {error}", folder.folder))?;
    let path = dir
        .join(file)
        .canonicalize()
        .map_err(|error| format!("could not open {file}: {error}"))?;
    if path.parent() != Some(dir.as_path()) {
        return Err(format!("{file} points outside {}", folder.folder));
    }
    let handle =
        fs::File::open(&path).map_err(|error| format!("could not open {file}: {error}"))?;
    let mut bytes = Vec::new();
    handle
        .take(MAX_REPORT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read {file}: {error}"))?;
    if bytes.len() as u64 > MAX_REPORT_BYTES {
        return Err(format!(
            "{file} is too large to show (over {} MiB)",
            MAX_REPORT_BYTES / 1024 / 1024
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn validate_report_name(file: &str) -> Result<(), String> {
    let plain = !file.is_empty()
        && !file.starts_with('.')
        && !file.contains(['/', '\\', '\0', ':'])
        && file.to_ascii_lowercase().ends_with(".html");
    if plain {
        Ok(())
    } else {
        Err(format!("not a report file name: {file:?}"))
    }
}

#[cfg(test)]
mod tests;
