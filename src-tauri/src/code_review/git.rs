use std::path::Path;
use std::process::{Command, Stdio};

pub(super) fn git_stdout(project: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(project)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("could not run git: {error}"))?;
    if !output.status.success() {
        let command = args.first().copied().unwrap_or_default();
        return Err(format!(
            "git {command} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}
