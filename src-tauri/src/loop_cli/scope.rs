use std::path::{Path, PathBuf};

pub(super) fn is_allowed_run_dir_root(root: &str) -> bool {
    matches!(root, ".loop" | ".adversarial")
}

/// Only pass through recognized values; `default` and empty become `None` so
/// the CLI sees no flag at all (matches its own default).
pub(super) fn normalize_effort(effort: Option<&str>) -> Option<String> {
    let raw = effort?.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("default") {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    match lower.as_str() {
        "low" | "medium" | "high" | "xhigh" => Some(lower),
        _ => None,
    }
}

#[derive(Debug)]
pub(super) struct InvocationScope {
    pub(super) cwd: PathBuf,
    pub(super) system_prompt_path: Option<String>,
}

pub(super) fn validate_loop_invocation_scope(
    cwd: &str,
    run_id: &str,
    run_dir_root: &str,
    system_prompt_path: Option<&str>,
) -> Result<InvocationScope, String> {
    if !crate::loop_prompts::is_safe_run_id(run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }

    let cwd_path = PathBuf::from(cwd);
    let cwd_canon = cwd_path
        .canonicalize()
        .map_err(|e| format!("invalid cwd: {e}"))?;
    if !cwd_canon.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }

    let run_dir = cwd_canon.join(run_dir_root).join("runs").join(run_id);
    let run_dir_canon = run_dir
        .canonicalize()
        .map_err(|e| format!("invalid run directory: {e}"))?;
    if !run_dir_canon.is_dir() {
        return Err(format!("run directory is not a directory: {run_dir:?}"));
    }
    if !run_dir_canon.starts_with(&cwd_canon) {
        return Err("run directory escapes cwd".to_string());
    }

    let system_prompt_path = match system_prompt_path {
        Some(path) => Some(validate_system_prompt_path(path, &run_dir_canon)?),
        None => None,
    };

    Ok(InvocationScope {
        cwd: cwd_canon,
        system_prompt_path,
    })
}

pub(super) fn validate_system_prompt_path(path: &str, run_dir: &Path) -> Result<String, String> {
    let prompt_path = PathBuf::from(path);
    let prompt_canon = prompt_path
        .canonicalize()
        .map_err(|e| format!("invalid system prompt path: {e}"))?;
    if !prompt_canon.is_file() {
        return Err(format!("system prompt path is not a file: {path}"));
    }

    let prompt_name = prompt_canon
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "system prompt path has no file name".to_string())?;
    if !crate::loop_prompts::is_known_prompt(prompt_name) {
        return Err(format!("system prompt not allowed: {prompt_name}"));
    }

    let prompts_dir = run_dir.join("prompts");
    let prompts_dir_canon = prompts_dir
        .canonicalize()
        .map_err(|e| format!("invalid prompts directory: {e}"))?;
    let parent = prompt_canon
        .parent()
        .ok_or_else(|| "system prompt path has no parent".to_string())?;
    if parent != prompts_dir_canon {
        return Err("system prompt must live in the run prompts directory".to_string());
    }

    Ok(prompt_canon.to_string_lossy().to_string())
}
