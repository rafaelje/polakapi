use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

pub(super) fn git_stdout(project: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = git_read(project, args)?;
    if !output.status.success() {
        let command = args.first().copied().unwrap_or_default();
        return Err(format!("git {command} failed: {}", trimmed(&output.stderr)));
    }
    Ok(output.stdout)
}

pub(super) fn git_with_pathspec(
    project: &Path,
    command: &[&str],
    spec: &[String],
) -> Result<Vec<u8>, String> {
    let mut args = command.to_vec();
    args.extend(spec.iter().map(String::as_str));
    git_stdout(project, &args)
}

pub(super) fn git_read(project: &Path, args: &[&str]) -> Result<Output, String> {
    git(project)
        .arg("--no-optional-locks")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(run_error)
}

pub(super) fn git_unattended(project: &Path, args: &[&str]) -> Result<Output, String> {
    git(project)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output()
        .map_err(run_error)
}

pub(super) fn git_with_stdin(
    project: &Path,
    args: &[&str],
    input: &[u8],
) -> Result<Output, String> {
    let mut child = git(project)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(run_error)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input)
            .map_err(|error| format!("could not pass input to git: {error}"))?;
    }
    child.wait_with_output().map_err(run_error)
}

pub(super) fn has_head(project: &Path) -> bool {
    git_stdout(project, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

pub(super) fn nul_records(raw: &[u8]) -> impl Iterator<Item = &[u8]> {
    raw.split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
}

pub(super) fn lossy(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw).into_owned()
}

pub(super) fn trimmed(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw).trim().to_string()
}

fn git(project: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(project);
    command
}

fn run_error(error: std::io::Error) -> String {
    format!("could not run git: {error}")
}
