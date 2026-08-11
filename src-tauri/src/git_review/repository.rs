use std::path::PathBuf;
use std::process::{Command, Stdio};

pub(crate) fn validate_repo_path(project_path: &str) -> Result<PathBuf, String> {
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path is not a directory: {project_path}"));
    }
    if !project.join(".git").exists() {
        return Err(format!("project is not a git repo: {project_path}"));
    }
    Ok(project)
}

pub(super) fn current_branch(project: &PathBuf) -> Result<String, String> {
    let output = git_output(project, ["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !output.status.success() {
        return Err(format!(
            "git rev-parse HEAD failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(super) fn origin_head(project: &PathBuf) -> Result<Option<String>, String> {
    let output = git_output(project, ["symbolic-ref", "refs/remotes/origin/HEAD"])?;
    if !output.status.success() {
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let name = raw
        .strip_prefix("refs/remotes/origin/")
        .map(str::to_string)
        .unwrap_or(raw);
    Ok((!name.is_empty()).then_some(name))
}

pub(super) fn ref_exists(project: &PathBuf, name: &str) -> Result<bool, String> {
    Ok(
        git_output(project, ["rev-parse", "--verify", "--quiet", name])?
            .status
            .success(),
    )
}

pub(super) fn rev_parse_verify(project: &PathBuf, name: &str) -> Result<String, String> {
    let output = git_output(project, ["rev-parse", "--verify", name])?;
    if !output.status.success() {
        return Err(format!(
            "unknown ref: {name} ({})",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(super) fn merge_base(project: &PathBuf, a: &str, b: &str) -> Result<String, String> {
    let output = git_output(project, ["merge-base", a, b])?;
    if !output.status.success() {
        return Err(format!(
            "git merge-base failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(super) fn is_safe_git_ref(name: &str) -> bool {
    if name.is_empty() || name.len() > 200 {
        return false;
    }
    if name.starts_with('-') || name.contains("..") || name.contains(':') || name.contains(' ') {
        return false;
    }
    name.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || matches!(
                character,
                '/' | '_' | '-' | '.' | '~' | '^' | '@' | '{' | '}'
            )
    })
}

fn git_output<const N: usize>(
    project: &PathBuf,
    args: [&str; N],
) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(project)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("could not run git: {error}"))
}
