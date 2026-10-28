use std::fs;
use std::io::Read;

use super::blocking;
use super::processes::{is_process_file, INDEX_FILE};
use super::review_folder::review_folder;
use crate::git_review::validate_repo_path;

const MAX_REPORT_BYTES: u64 = 8 * 1024 * 1024;

#[tauri::command]
pub async fn code_review_read_report(project_path: String, file: String) -> Result<String, String> {
    blocking(move || read_report_sync(&project_path, &file)).await
}

fn read_report_sync(project_path: &str, file: &str) -> Result<String, String> {
    if !is_report_name(file) {
        return Err(format!("not a review report: {file}"));
    }
    let project = validate_repo_path(project_path)?;
    let folder = review_folder(&project)?;
    let path = project.join(&folder.folder).join(file);
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| format!("could not read {file}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("not a regular file: {file}"));
    }
    if metadata.len() > MAX_REPORT_BYTES {
        return Err(format!(
            "{file} is larger than {} MB",
            MAX_REPORT_BYTES / 1024 / 1024
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(&path)
        .and_then(|handle| handle.take(MAX_REPORT_BYTES).read_to_end(&mut bytes))
        .map_err(|error| format!("could not read {file}: {error}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn is_report_name(file: &str) -> bool {
    let plain = !file.is_empty() && !file.contains(['/', '\\', '\0']) && !file.starts_with('.');
    plain && (file == INDEX_FILE || is_process_file(file))
}

#[cfg(test)]
mod tests;
