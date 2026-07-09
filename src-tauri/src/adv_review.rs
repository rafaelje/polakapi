//! Per-run storage for `/adversarial review`.
//!
//! Runs live at `<project>/.adversarial/runs/<runId>/`. This module mirrors
//! the shape of `loop_prompts::runs`/`storage` but is intentionally kept
//! separate so the debate-only file set (diff.patch, round-N-role.md,
//! findings.json, state.json, report.md) can evolve without affecting /loop.
//!
//! Shared helpers (`write_atomic`, `is_safe_run_id`, `bundled_content`,
//! `prompts_dir`) are re-used from `loop_prompts` — the two features share
//! the same "atomic per-file write" invariant.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::loop_prompts;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedAdvRunPaths {
    pub run_dir: String,
    pub prompts_dir: String,
}

/// The allowlist of run-scoped file names that can be read/written through
/// `adv_read_run_file` / `adv_write_run_file`. Kept restrictive on purpose —
/// the scheduler + report renderer are the only writers, and both know
/// exactly which files they produce. `round-<n>-<role>.md` is validated at
/// runtime by [`is_allowed_round_file`].
const ALLOWED_STATIC_FILES: &[&str] = &["diff.patch", "findings.json", "report.md"];

fn is_allowed_round_file(name: &str) -> bool {
    // round-1-critic.md, round-2-defender.md, ... up to 9 rounds.
    let rest = match name.strip_prefix("round-") {
        Some(r) => r,
        None => return false,
    };
    let rest = match rest.strip_suffix(".md") {
        Some(r) => r,
        None => return false,
    };
    let (n, role) = match rest.split_once('-') {
        Some(v) => v,
        None => return false,
    };
    if !matches!(role, "critic" | "defender") {
        return false;
    }
    matches!(n.parse::<u32>(), Ok(n) if (1..=9).contains(&n))
}

fn is_allowed_run_file(name: &str) -> bool {
    ALLOWED_STATIC_FILES.contains(&name) || is_allowed_round_file(name)
}

fn is_adversarial_prompt(name: &str) -> bool {
    matches!(name, "adversarial-critic.md" | "adversarial-defender.md")
}

fn resolve_run_dir(project_path: &str, run_id: &str) -> Result<PathBuf, String> {
    if !loop_prompts::is_safe_run_id(run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path is not a directory: {project_path}"));
    }
    Ok(project.join(".adversarial").join("runs").join(run_id))
}

fn require_existing_run_dir(project_path: &str, run_id: &str) -> Result<PathBuf, String> {
    let run_dir = resolve_run_dir(project_path, run_id)?;
    if !run_dir.is_dir() {
        return Err(format!("run_dir does not exist: {run_dir:?}"));
    }
    Ok(run_dir)
}

/// Creates `<project>/.adversarial/runs/<runId>/prompts/` under the target
/// project. Fails if the run already exists (runs are immutable — starting a
/// new review always uses a fresh runId). Prompt files are seeded lazily via
/// [`adv_ensure_run_prompt`].
#[tauri::command]
pub async fn adv_create_run(
    project_path: String,
    run_id: String,
) -> Result<CreatedAdvRunPaths, String> {
    let run_dir = resolve_run_dir(&project_path, &run_id)?;
    tokio::task::spawn_blocking(move || -> Result<CreatedAdvRunPaths, String> {
        if run_dir.exists() {
            return Err(format!("run_dir already exists: {run_dir:?}"));
        }
        std::fs::create_dir_all(&run_dir)
            .map_err(|e| format!("could not create {run_dir:?}: {e}"))?;
        let prompts_dir = run_dir.join("prompts");
        std::fs::create_dir_all(&prompts_dir)
            .map_err(|e| format!("could not create {prompts_dir:?}: {e}"))?;
        Ok(CreatedAdvRunPaths {
            run_dir: run_dir.to_string_lossy().to_string(),
            prompts_dir: prompts_dir.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Reads a run file. Returns "" if it does not exist (parity with the /loop
/// storage commands so callers do not need a separate "exists" probe).
#[tauri::command]
pub async fn adv_read_run_file(
    project_path: String,
    run_id: String,
    file: String,
) -> Result<String, String> {
    if !is_allowed_run_file(&file) {
        return Err(format!("file name not allowed: {file}"));
    }
    let run_dir = require_existing_run_dir(&project_path, &run_id)?;
    let target = run_dir.join(&file);
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        match std::fs::read_to_string(&target) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("could not read {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Writes a run file atomically. The run dir must exist (created by
/// [`adv_create_run`]).
#[tauri::command]
pub async fn adv_write_run_file(
    project_path: String,
    run_id: String,
    file: String,
    content: String,
) -> Result<(), String> {
    if !is_allowed_run_file(&file) {
        return Err(format!("file name not allowed: {file}"));
    }
    let run_dir = require_existing_run_dir(&project_path, &run_id)?;
    let target = run_dir.join(&file);
    tokio::task::spawn_blocking(move || loop_prompts::write_atomic(&target, &content))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Reads `<run>/state.json`. Empty string on missing so the scheduler can
/// treat that as "first startup".
#[tauri::command]
pub async fn adv_read_state_file(project_path: String, run_id: String) -> Result<String, String> {
    let run_dir = require_existing_run_dir(&project_path, &run_id)?;
    let target = run_dir.join("state.json");
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        match std::fs::read_to_string(&target) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("could not read {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Writes `<run>/state.json` atomically. The TS layer is authoritative on the
/// schema; we do not validate here.
#[tauri::command]
pub async fn adv_write_state_file(
    project_path: String,
    run_id: String,
    content: String,
) -> Result<(), String> {
    let run_dir = require_existing_run_dir(&project_path, &run_id)?;
    let target = run_dir.join("state.json");
    tokio::task::spawn_blocking(move || loop_prompts::write_atomic(&target, &content))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Lazily materializes an adversarial prompt in `<run>/prompts/<name>`,
/// falling back to the bundled seed when the app-config global copy is
/// missing. Returns immediately if the file already exists in the run.
#[tauri::command]
pub async fn adv_ensure_run_prompt(
    app: tauri::AppHandle,
    project_path: String,
    run_id: String,
    name: String,
) -> Result<(), String> {
    if !is_adversarial_prompt(&name) {
        return Err(format!("unknown adversarial prompt: {name}"));
    }
    let run_dir = require_existing_run_dir(&project_path, &run_id)?;
    let globals_dir = loop_prompts::prompts_dir(&app)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let prompts_dir = run_dir.join("prompts");
        std::fs::create_dir_all(&prompts_dir)
            .map_err(|e| format!("could not create {prompts_dir:?}: {e}"))?;
        let target = prompts_dir.join(&name);
        if target.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(&globals_dir)
            .map_err(|e| format!("could not create {globals_dir:?}: {e}"))?;
        let global_target = globals_dir.join(&name);
        let content = match std::fs::read_to_string(&global_target) {
            Ok(c) => c,
            Err(_) => loop_prompts::bundled_content(&name)
                .ok_or_else(|| format!("missing bundled seed for {name}"))?
                .to_string(),
        };
        loop_prompts::write_atomic(&target, &content)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Reads the run-local adversarial prompt (empty string on missing). The
/// scheduler prefers this over the global copy because per-run overrides may
/// have been staged in Step 1.
#[tauri::command]
pub async fn adv_read_run_prompt(
    project_path: String,
    run_id: String,
    name: String,
) -> Result<String, String> {
    if !is_adversarial_prompt(&name) {
        return Err(format!("unknown adversarial prompt: {name}"));
    }
    let run_dir = require_existing_run_dir(&project_path, &run_id)?;
    let target = run_dir.join("prompts").join(&name);
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        match std::fs::read_to_string(&target) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("could not read {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Writes the run-local adversarial prompt atomically. Used by Step 1 to
/// persist inline edits before the scheduler starts.
#[tauri::command]
pub async fn adv_write_run_prompt(
    project_path: String,
    run_id: String,
    name: String,
    content: String,
) -> Result<(), String> {
    if !is_adversarial_prompt(&name) {
        return Err(format!("unknown adversarial prompt: {name}"));
    }
    let run_dir = require_existing_run_dir(&project_path, &run_id)?;
    let prompts_dir = run_dir.join("prompts");
    let target = prompts_dir.join(&name);
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&prompts_dir)
            .map_err(|e| format!("could not create {prompts_dir:?}: {e}"))?;
        loop_prompts::write_atomic(&target, &content)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_static_files() {
        assert!(is_allowed_run_file("diff.patch"));
        assert!(is_allowed_run_file("findings.json"));
        assert!(is_allowed_run_file("report.md"));
    }

    #[test]
    fn accepts_round_files() {
        assert!(is_allowed_run_file("round-1-critic.md"));
        assert!(is_allowed_run_file("round-2-defender.md"));
        assert!(is_allowed_run_file("round-9-critic.md"));
    }

    #[test]
    fn rejects_bad_names() {
        assert!(!is_allowed_run_file("state.json"));
        assert!(!is_allowed_run_file("round-0-critic.md"));
        assert!(!is_allowed_run_file("round-10-critic.md"));
        assert!(!is_allowed_run_file("round-1-other.md"));
        assert!(!is_allowed_run_file("../etc/passwd"));
        assert!(!is_allowed_run_file("prompts/adversarial-critic.md"));
    }

    #[test]
    fn accepts_adversarial_prompts() {
        assert!(is_adversarial_prompt("adversarial-critic.md"));
        assert!(is_adversarial_prompt("adversarial-defender.md"));
        assert!(!is_adversarial_prompt("analysis.md"));
    }
}
