//! Clones a git repository into a destination directory and returns the new
//! path, so the frontend can register it as a project.

use std::path::Path;
use std::process::{Command, Stdio};

#[tauri::command]
pub async fn git_clone_repo(url: String, dest_parent: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || clone_repo_sync(&url, &dest_parent))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn clone_repo_sync(url: &str, dest_parent: &str) -> Result<String, String> {
    let url = url.trim();
    if !is_valid_git_url(url) {
        return Err(format!("invalid git url: {url}"));
    }
    let parent = Path::new(dest_parent);
    if !parent.is_dir() {
        return Err(format!("destination is not a directory: {dest_parent}"));
    }
    let dir_name = repo_dir_name(url)
        .ok_or_else(|| format!("could not derive a directory name from: {url}"))?;
    let dest = parent.join(&dir_name);
    if dest.exists() {
        return Err(format!("destination already exists: {}", dest.display()));
    }

    let dest_str = dest.to_string_lossy().to_string();
    // Batch/non-interactive env so a credential or passphrase prompt fails
    // fast instead of hanging the invoke forever.
    let output = Command::new("git")
        .args(["clone", "--", url, &dest_str])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run git clone: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(dest_str)
}

fn is_valid_git_url(url: &str) -> bool {
    if url.is_empty() || url.len() > 2048 || url.starts_with('-') {
        return false;
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    url.starts_with("git@")
        || url.starts_with("ssh://")
        || url.starts_with("https://")
        || url.starts_with("http://")
}

fn repo_dir_name(url: &str) -> Option<String> {
    let trimmed = url.trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    let ok = !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    ok.then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_common_git_urls() {
        assert!(is_valid_git_url("git@github.com:user/repo.git"));
        assert!(is_valid_git_url("https://github.com/user/repo.git"));
        assert!(is_valid_git_url("https://github.com/user/repo"));
        assert!(is_valid_git_url("ssh://git@host/user/repo.git"));
    }

    #[test]
    fn rejects_dangerous_or_malformed_urls() {
        assert!(!is_valid_git_url(""));
        assert!(!is_valid_git_url("-oProxyCommand=evil"));
        assert!(!is_valid_git_url("git@host:repo.git evil"));
        assert!(!is_valid_git_url("/local/path/repo"));
        assert!(!is_valid_git_url("ftp://host/repo"));
    }

    #[test]
    fn derives_directory_name_from_url() {
        assert_eq!(
            repo_dir_name("git@github.com:miguelfiguera/angular-crud-uneti.git").as_deref(),
            Some("angular-crud-uneti")
        );
        assert_eq!(
            repo_dir_name("https://github.com/user/repo").as_deref(),
            Some("repo")
        );
        assert_eq!(
            repo_dir_name("https://github.com/user/repo.git/").as_deref(),
            Some("repo")
        );
        assert_eq!(repo_dir_name("git@github.com:"), None);
    }

    #[test]
    fn clone_rejects_bad_inputs_before_running_git() {
        assert!(clone_repo_sync("not-a-url", "/tmp").is_err());
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        assert!(clone_repo_sync("git@github.com:u/r.git", &missing.to_string_lossy()).is_err());
    }

    #[test]
    fn clones_a_local_repo_via_file_scheme_rejection() {
        // file:// and plain paths are intentionally rejected — cloning is for
        // remote URLs only.
        assert!(!is_valid_git_url("file:///home/user/repo"));
    }
}
