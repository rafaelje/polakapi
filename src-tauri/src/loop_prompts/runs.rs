//! Run lifecycle: creating `<project>/.loop/runs/<id>/` with the prompts
//! atomically copied from the globals, plus read/write of the per-run
//! manifest files (`01-problem-draft.md`, `01-problem.md`, `02-phases.md`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{ensure_dir_sync, is_safe_run_id, prompts_dir, write_atomic};

/// Output of `loop_create_run`: absolute paths of the created directories,
/// in case the frontend wants to show or open them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedRunPaths {
    pub run_dir: String,
    pub prompts_dir: String,
}

/// Creates the run tree at `<projectPath>/.loop/runs/<runId>/` and copies the
/// 7 global prompts inside atomically (each file is written to a temp inside
/// the same dir and renamed).
///
/// The `runId` is sanitized: only `[A-Za-z0-9_-]` is allowed. Any other char
/// is rejected to disallow traversal (`..`) or separators. The frontend
/// should generate IDs with `crypto.randomUUID()` or similar.
#[tauri::command]
pub async fn loop_create_run(
    app: tauri::AppHandle,
    project_path: String,
    run_id: String,
) -> Result<CreatedRunPaths, String> {
    if !is_safe_run_id(&run_id) {
        return Err(format!("invalid run_id: {run_id} (only [A-Za-z0-9_-])"));
    }
    let globals_dir = prompts_dir(&app)?;

    tokio::task::spawn_blocking(move || -> Result<CreatedRunPaths, String> {
        // Ensure globals first — a run without prompts makes no sense.
        ensure_dir_sync(&globals_dir)?;

        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project_path is not a directory: {project_path}"));
        }
        let run_dir = project.join(".loop").join("runs").join(&run_id);
        if run_dir.exists() {
            return Err(format!("run_dir already exists: {run_dir:?}"));
        }
        std::fs::create_dir_all(&run_dir)
            .map_err(|e| format!("could not create {run_dir:?}: {e}"))?;

        let prompts_dir_run = run_dir.join("prompts");
        std::fs::create_dir_all(&prompts_dir_run)
            .map_err(|e| format!("could not create {prompts_dir_run:?}: {e}"))?;

        // Per-run prompts are materialized lazily via `loop_ensure_run_prompt`:
        // step 1 only needs `problem-intake.md`, step 2 only needs
        // `phase-decomposition.md`, and steps 3/4 ensure their own prompts on
        // demand. Eagerly seeding all 7 here would dirty the run dir with
        // files the user may never reach.

        Ok(CreatedRunPaths {
            run_dir: run_dir.to_string_lossy().to_string(),
            prompts_dir: prompts_dir_run.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Allowed file names for `loop_read_run_file` / `loop_write_run_file`.
/// We only accept simple components (no separators) and restrict to the set
/// the run flow currently uses — `01-problem-draft.md` (chat auto-save),
/// `01-problem.md` (final consolidation), `02-phases.md` (step 2 phase
/// manifest — serialized JSON of `Phase[]`). We keep this restrictive on
/// purpose: the per-phase files (`logic.md`, `visual.html`) live in
/// subdirectories and have their own commands (`loop_*_phase_file`).
const ALLOWED_RUN_FILES: &[&str] = &["01-problem-draft.md", "01-problem.md", "02-phases.md"];

fn is_allowed_run_file(name: &str) -> bool {
    ALLOWED_RUN_FILES.contains(&name)
}

/// Resolves `<projectPath>/.loop/runs/<runId>/<file>` applying the same
/// `run_id` validation as `loop_create_run` + an allowlist on `file`. The
/// result is an absolute path the caller can read/write; the run_dir must
/// exist (otherwise we return an error — we do not auto-create it to avoid
/// masking ordering bugs).
fn resolve_run_file(project_path: &str, run_id: &str, file: &str) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    if !is_allowed_run_file(file) {
        return Err(format!("file name not allowed: {file}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path is not a directory: {project_path}"));
    }
    let run_dir = project.join(".loop").join("runs").join(run_id);
    if !run_dir.is_dir() {
        return Err(format!("run_dir does not exist: {run_dir:?}"));
    }
    Ok(run_dir.join(file))
}

/// Reads a file from the run. If it does not exist, returns an empty string
/// — the chat uses this when hydrating the draft of an interrupted run
/// (Section 9 handles the formal resume; for now tolerating "does not exist"
/// as "no draft" is enough).
#[tauri::command]
pub async fn loop_read_run_file(
    project_path: String,
    run_id: String,
    file: String,
) -> Result<String, String> {
    let target = resolve_run_file(&project_path, &run_id, &file)?;
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

/// Writes a file from the run atomically (same `write_atomic` as the global
/// prompts). The run_dir must exist — it is created by `loop_create_run`.
#[tauri::command]
pub async fn loop_write_run_file(
    project_path: String,
    run_id: String,
    file: String,
    content: String,
) -> Result<(), String> {
    let target = resolve_run_file(&project_path, &run_id, &file)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> { write_atomic(&target, &content) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}
