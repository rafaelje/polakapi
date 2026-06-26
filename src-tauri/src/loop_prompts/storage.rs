//! Per-phase files (`logic.md`, `visual.html`), per-agent outputs
//! (`outputs/<phase>/<agent>.{md,diff}`), the run-wide `state.json`, the
//! per-batch consolidated knowledge (`outputs/batches/<id>/knowledge.md`),
//! and the git diff snapshot helper.
//!
//! All of these live under `<run>/...` and share the same validation
//! pattern: `run_id` and any slug are restricted to `[A-Za-z0-9_-]`, file
//! names are checked against a tight allowlist, and writes go through
//! `write_atomic`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use super::{file_has_content, is_safe_phase_slug, is_safe_run_id, write_atomic};

// ---------------------------------------------------------------------------
// Section 5: per-phase logic.md / visual.html
// ---------------------------------------------------------------------------

const ALLOWED_PHASE_FILES: &[&str] = &["logic.md", "visual.html"];

fn is_allowed_phase_file(name: &str) -> bool {
    ALLOWED_PHASE_FILES.contains(&name)
}

fn resolve_phases_dir(project_path: &str, run_id: &str) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path is not a directory: {project_path}"));
    }
    let run_dir = project.join(".loop").join("runs").join(run_id);
    if !run_dir.is_dir() {
        return Err(format!("run_dir does not exist: {run_dir:?}"));
    }
    Ok(run_dir.join("phases"))
}

fn resolve_phase_dir(
    project_path: &str,
    run_id: &str,
    phase_slug: &str,
) -> Result<PathBuf, String> {
    if !is_safe_phase_slug(phase_slug) {
        return Err(format!("invalid phase_slug: {phase_slug}"));
    }
    let phases = resolve_phases_dir(project_path, run_id)?;
    Ok(phases.join(phase_slug))
}

/// Creates (or ensures) `<run>/phases/<phase_slug>/` and returns the absolute
/// path. `withVisual=true` also creates an empty `visual.html` so the UI can
/// show the tab right away. `logic.md` is always created empty if it does
/// not exist — the step 2 agent writes the initial content into it later.
#[tauri::command]
pub async fn loop_create_phase_dir(
    project_path: String,
    run_id: String,
    phase_slug: String,
    with_visual: bool,
) -> Result<String, String> {
    let target = resolve_phase_dir(&project_path, &run_id, &phase_slug)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        std::fs::create_dir_all(&target)
            .map_err(|e| format!("could not create {target:?}: {e}"))?;
        let logic = target.join("logic.md");
        if !logic.exists() {
            write_atomic(&logic, "")?;
        }
        if with_visual {
            let visual = target.join("visual.html");
            if !visual.exists() {
                write_atomic(&visual, "")?;
            }
        }
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Deletes the dir of a phase. Does not fail if it did not exist — deleting
/// is idempotent from the UI perspective.
#[tauri::command]
pub async fn loop_delete_phase_dir(
    project_path: String,
    run_id: String,
    phase_slug: String,
) -> Result<(), String> {
    let target = resolve_phase_dir(&project_path, &run_id, &phase_slug)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        match std::fs::remove_dir_all(&target) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not delete {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Reads `<phase>/<file>`. `file` must be in `ALLOWED_PHASE_FILES`. If the
/// file does not exist, returns an empty string (the UI treats it as "no
/// content yet").
#[tauri::command]
pub async fn loop_read_phase_file(
    project_path: String,
    run_id: String,
    phase_slug: String,
    file: String,
) -> Result<String, String> {
    if !is_allowed_phase_file(&file) {
        return Err(format!("file name not allowed: {file}"));
    }
    let phase = resolve_phase_dir(&project_path, &run_id, &phase_slug)?;
    let target = phase.join(&file);
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

/// Writes `<phase>/<file>` atomically. If the phase dir does not exist, it
/// creates it — this lets the "add phase" flow create the subdir when saving
/// the first content. `file` must be in `ALLOWED_PHASE_FILES`.
#[tauri::command]
pub async fn loop_write_phase_file(
    project_path: String,
    run_id: String,
    phase_slug: String,
    file: String,
    content: String,
) -> Result<(), String> {
    if !is_allowed_phase_file(&file) {
        return Err(format!("file name not allowed: {file}"));
    }
    let phase = resolve_phase_dir(&project_path, &run_id, &phase_slug)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&phase).map_err(|e| format!("could not create {phase:?}: {e}"))?;
        let target = phase.join(&file);
        write_atomic(&target, &content)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// On-disk status of a phase: indicates whether `logic.md` / `visual.html`
/// are present AND have non-empty content. The UI uses it to show `md` /
/// `html` badges and to enable the "→ Step 3" button (all phases with
/// `hasLogic=true`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseDirStatus {
    pub slug: String,
    pub has_logic: bool,
    pub has_visual: bool,
}

/// Lists the subdirs of `<run>/phases/`. Returns `Vec<PhaseDirStatus>` with a
/// flag per file. Sorts by name so the UI has a predictable order even if
/// the `02-phases.md` manifest gets corrupted. If the `phases/` dir does not
/// exist (run without step 2 yet), returns an empty list.
#[tauri::command]
pub async fn loop_list_phase_dirs(
    project_path: String,
    run_id: String,
) -> Result<Vec<PhaseDirStatus>, String> {
    let phases = resolve_phases_dir(&project_path, &run_id)?;
    tokio::task::spawn_blocking(move || -> Result<Vec<PhaseDirStatus>, String> {
        let entries = match std::fs::read_dir(&phases) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("could not list {phases:?}: {e}")),
        };
        let mut out: Vec<PhaseDirStatus> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let slug = entry.file_name().to_string_lossy().to_string();
            if !is_safe_phase_slug(&slug) {
                continue;
            }
            let logic = path.join("logic.md");
            let visual = path.join("visual.html");
            out.push(PhaseDirStatus {
                slug,
                has_logic: file_has_content(&logic),
                has_visual: file_has_content(&visual),
            });
        }
        out.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// ---------------------------------------------------------------------------
// Section 7: outputs/<phase>/<agent>.{md,diff}, state.json, git diff snapshots
// ---------------------------------------------------------------------------

pub(super) const ALLOWED_OUTPUT_AGENTS: &[&str] = &[
    "analysis",
    "implementation",
    "review",
    "knowledge",
    "integration",
];
const ALLOWED_OUTPUT_EXTENSIONS: &[&str] = &["md", "diff"];

pub(super) fn is_allowed_output_agent(agent: &str) -> bool {
    ALLOWED_OUTPUT_AGENTS.contains(&agent)
}

fn is_allowed_output_extension(ext: &str) -> bool {
    ALLOWED_OUTPUT_EXTENSIONS.contains(&ext)
}

/// Resolves `<run>/outputs/<phase_slug>/<agent>.<ext>` applying the same
/// validation as the rest. Creates the dir if it does not exist — the
/// scheduler writes outputs before `phases/<slug>/` is guaranteed.
fn resolve_output_file(
    project_path: &str,
    run_id: &str,
    phase_slug: &str,
    agent: &str,
    ext: &str,
) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    if !is_safe_phase_slug(phase_slug) {
        return Err(format!("invalid phase_slug: {phase_slug}"));
    }
    if !is_allowed_output_agent(agent) {
        return Err(format!("agent not allowed: {agent}"));
    }
    if !is_allowed_output_extension(ext) {
        return Err(format!("extension not allowed: {ext}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path is not a directory: {project_path}"));
    }
    let run_dir = project.join(".loop").join("runs").join(run_id);
    if !run_dir.is_dir() {
        return Err(format!("run_dir does not exist: {run_dir:?}"));
    }
    Ok(run_dir
        .join("outputs")
        .join(phase_slug)
        .join(format!("{agent}.{ext}")))
}

/// Reads an agent output. Returns an empty string if it does not exist (not
/// an error — the scheduler checks presence before invoking the next stage).
#[tauri::command]
pub async fn loop_read_output_file(
    project_path: String,
    run_id: String,
    phase_slug: String,
    agent: String,
    ext: String,
) -> Result<String, String> {
    let target = resolve_output_file(&project_path, &run_id, &phase_slug, &agent, &ext)?;
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

/// Writes an agent output atomically. Creates `outputs/<phase>/` if it does
/// not exist.
#[tauri::command]
pub async fn loop_write_output_file(
    project_path: String,
    run_id: String,
    phase_slug: String,
    agent: String,
    ext: String,
    content: String,
) -> Result<(), String> {
    let target = resolve_output_file(&project_path, &run_id, &phase_slug, &agent, &ext)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> { write_atomic(&target, &content) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Resolves `<run>/state.json`. The run_dir must exist.
fn resolve_state_file(project_path: &str, run_id: &str) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Err(format!("project_path is not a directory: {project_path}"));
    }
    let run_dir = project.join(".loop").join("runs").join(run_id);
    if !run_dir.is_dir() {
        return Err(format!("run_dir does not exist: {run_dir:?}"));
    }
    Ok(run_dir.join("state.json"))
}

/// Reads `<run>/state.json`. If it does not exist, returns an empty string —
/// the scheduler uses that as "first run startup, write an initial state".
#[tauri::command]
pub async fn loop_read_state_file(project_path: String, run_id: String) -> Result<String, String> {
    let target = resolve_state_file(&project_path, &run_id)?;
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

/// Writes `<run>/state.json` atomically. The frontend passes the serialized
/// JSON (we do not validate the schema here — the TS is the source of truth).
#[tauri::command]
pub async fn loop_write_state_file(
    project_path: String,
    run_id: String,
    content: String,
) -> Result<(), String> {
    let target = resolve_state_file(&project_path, &run_id)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> { write_atomic(&target, &content) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Snapshot of the current repo diff in unified format. Combines:
/// - `git diff HEAD` (tracked + staged + unstaged vs HEAD).
/// - Listing of untracked files (one line per file, no content — to avoid
///   inflating the output with binaries or large assets).
///
/// If `project_path` is not a git repo, returns an empty string (semantics
/// "no trackable diff"). If `git` is not in PATH, returns an explanatory
/// comment as the diff — not a fatal error.
#[tauri::command]
pub async fn loop_git_diff_snapshot(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> { git_diff_sync(&project_path) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn git_diff_sync(project_path: &str) -> Result<String, String> {
    let project = PathBuf::from(project_path);
    if !project.is_dir() {
        return Ok(String::new());
    }
    if !project.join(".git").exists() {
        // Not a git repo — empty snapshot.
        return Ok(String::new());
    }

    let diff_out = Command::new("git")
        .args(["diff", "HEAD"])
        .current_dir(&project)
        .stdin(Stdio::null())
        .output();
    let diff = match diff_out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        Ok(out) => {
            // exit != 0 can happen if there is no HEAD yet (a freshly
            // init'd repo). In that case we return an empty snapshot + note.
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Ok(format!("# git diff failed: {}\n", stderr.trim()));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok("# git is not in PATH — diff snapshot unavailable\n".to_string());
        }
        Err(e) => return Err(format!("error invoking git: {e}")),
    };

    // Listing of untracked files without content — only paths to keep the
    // diff readable even if there are heavy assets.
    let untracked_out = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&project)
        .stdin(Stdio::null())
        .output();
    let untracked = match untracked_out {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => String::new(),
    };

    let mut combined = String::new();
    combined.push_str(&diff);
    let untracked_trimmed = untracked.trim();
    if !untracked_trimmed.is_empty() {
        if !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str("\n# Untracked files (paths only):\n");
        for line in untracked_trimmed.lines() {
            combined.push_str(&format!("# - {line}\n"));
        }
    }
    Ok(combined)
}

// ---------------------------------------------------------------------------
// Section 8: per-batch outputs of the hybrid mode
// ---------------------------------------------------------------------------

const ALLOWED_BATCH_FILES: &[&str] = &["knowledge.md"];

fn is_allowed_batch_file(name: &str) -> bool {
    ALLOWED_BATCH_FILES.contains(&name)
}

/// Resolves `<run>/outputs/batches/<batch_id>/<file>`. Applies the same
/// validations as the rest of the module commands — `run_id` and `batch_id`
/// go through `is_safe_run_id`, `file` through `is_allowed_batch_file`.
fn resolve_batch_file(
    project_path: &str,
    run_id: &str,
    batch_id: &str,
    file: &str,
) -> Result<PathBuf, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    if !is_safe_run_id(batch_id) {
        return Err(format!("invalid batch_id: {batch_id}"));
    }
    if !is_allowed_batch_file(file) {
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
    Ok(run_dir
        .join("outputs")
        .join("batches")
        .join(batch_id)
        .join(file))
}

/// Reads the consolidated integrator output for a batch. Returns an empty
/// string if it does not exist (semantics "not generated yet").
#[tauri::command]
pub async fn loop_read_batch_file(
    project_path: String,
    run_id: String,
    batch_id: String,
    file: String,
) -> Result<String, String> {
    let target = resolve_batch_file(&project_path, &run_id, &batch_id, &file)?;
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

/// Writes the consolidated integrator output atomically. Creates
/// `outputs/batches/<batch_id>/` if it does not exist.
#[tauri::command]
pub async fn loop_write_batch_file(
    project_path: String,
    run_id: String,
    batch_id: String,
    file: String,
    content: String,
) -> Result<(), String> {
    let target = resolve_batch_file(&project_path, &run_id, &batch_id, &file)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> { write_atomic(&target, &content) })
        .await
        .map_err(|e| format!("join error: {e}"))?
}

// Section 8.4 (conflict detection between batch phases) does NOT need a
// dedicated command because the detection is done in TS over the diffs
// read via `loop_read_output_file`.

#[allow(dead_code)]
fn _path_marker(_p: &Path) {}
