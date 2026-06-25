//! Management of the 7 global prompts and the `/loop` runs.
//!
//! Exposed Tauri commands:
//! - `loop_ensure_prompts_dir`: creates `<app-config>/prompts/` and restores
//!   missing files from the bundled ones (`include_str!`).
//! - `loop_read_global_prompt(name)` / `loop_write_global_prompt(name, content)`:
//!   read/write of the 7 editable files.
//! - `loop_create_run(projectPath, runId)`: creates the tree
//!   `<project>/.loop/runs/<runId>/` with the `prompts/` subfolder copied
//!   atomically from the globals.
//! - `loop_validate_cli_model(cli, model)`: checks that the CLI binary is in
//!   PATH and pings the model. Returns `{ ok, reason }`.
//!
//! Decision: bundling via `include_str!`. It is the simplest pattern with no
//! new dependencies; the binary grows ~10KB (the 7 .md files combined),
//! nothing compared with the overhead of registering them as Tauri resources
//! and reading them at runtime. See design.md (section "Open Questions",
//! entry "How to bundle the 7 default prompts").

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::process::Command as TokioCommand;

/// The 7 canonical prompt names. Any other name is rejected by
/// `loop_read_global_prompt` / `loop_write_global_prompt`. We keep this
/// constant as the single source of truth so that a typo in TS does not
/// produce orphan files.
pub const PROMPT_NAMES: [&str; 7] = [
    "problem-intake.md",
    "phase-decomposition.md",
    "analysis.md",
    "implementation.md",
    "review.md",
    "knowledge.md",
    "integration.md",
];

/// Bundled content of each prompt. Embedded with `include_str!` from
/// `src-tauri/prompts/` at build time — if any of those files does not exist
/// the build fails.
fn bundled_content(name: &str) -> Option<&'static str> {
    match name {
        "problem-intake.md" => Some(include_str!("../prompts/problem-intake.md")),
        "phase-decomposition.md" => Some(include_str!("../prompts/phase-decomposition.md")),
        "analysis.md" => Some(include_str!("../prompts/analysis.md")),
        "implementation.md" => Some(include_str!("../prompts/implementation.md")),
        "review.md" => Some(include_str!("../prompts/review.md")),
        "knowledge.md" => Some(include_str!("../prompts/knowledge.md")),
        "integration.md" => Some(include_str!("../prompts/integration.md")),
        _ => None,
    }
}

fn is_known_prompt(name: &str) -> bool {
    PROMPT_NAMES.contains(&name)
}

/// Returns `<app-config>/prompts/` resolving the config dir from the app handle.
fn prompts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app_config_dir: {e}"))?;
    Ok(base.join("prompts"))
}

/// Creates (if absent) `<app-config>/prompts/` and restores every missing
/// file from the bundled set. Does not overwrite existing files — only
/// creates the missing ones.
///
/// Returns the list of restored names so the frontend can notify the user
/// which files it repopulated.
#[tauri::command]
pub async fn loop_ensure_prompts_dir(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = prompts_dir(&app)?;
    tokio::task::spawn_blocking(move || ensure_dir_sync(&dir))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn ensure_dir_sync(dir: &Path) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;

    let mut restored = Vec::new();
    for name in PROMPT_NAMES.iter() {
        let target = dir.join(name);
        if target.exists() {
            continue;
        }
        let seed =
            bundled_content(name).ok_or_else(|| format!("missing bundled seed for {name}"))?;
        write_atomic(&target, seed)?;
        restored.push((*name).to_string());
    }
    Ok(restored)
}

/// Reads the content of the given global prompt. If the file does not exist,
/// it restores it from the bundled content before reading (same invariant as
/// `loop_ensure_prompts_dir`, but scoped to a single file to avoid extra
/// steps in read paths).
#[tauri::command]
pub async fn loop_read_global_prompt(
    app: tauri::AppHandle,
    name: String,
) -> Result<String, String> {
    if !is_known_prompt(&name) {
        return Err(format!("unknown prompt: {name}"));
    }
    let dir = prompts_dir(&app)?;
    let name_clone = name.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
        let target = dir.join(&name_clone);
        if !target.exists() {
            let seed = bundled_content(&name_clone)
                .ok_or_else(|| format!("missing bundled seed for {name_clone}"))?;
            write_atomic(&target, seed)?;
        }
        std::fs::read_to_string(&target).map_err(|e| format!("could not read {target:?}: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Overwrites the run copy of a prompt with the current global content.
/// Useful when the global was updated after creating the run (runs already
/// created have an atomic copy from the moment of creation; this command
/// synchronizes them explicitly when the user asks for it).
#[tauri::command]
pub async fn loop_reset_run_prompt_to_global(
    app: tauri::AppHandle,
    project_path: String,
    run_id: String,
    name: String,
) -> Result<(), String> {
    if !is_known_prompt(&name) {
        return Err(format!("unknown prompt: {name}"));
    }
    if !is_safe_run_id(&run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    let global_dir = prompts_dir(&app)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Ensure the global exists; if not, restore it from the bundled seed.
        std::fs::create_dir_all(&global_dir)
            .map_err(|e| format!("could not create {global_dir:?}: {e}"))?;
        let global_target = global_dir.join(&name);
        if !global_target.exists() {
            let seed =
                bundled_content(&name).ok_or_else(|| format!("missing bundled seed for {name}"))?;
            write_atomic(&global_target, seed)?;
        }
        let content = std::fs::read_to_string(&global_target)
            .map_err(|e| format!("could not read {global_target:?}: {e}"))?;

        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project not found: {project:?}"));
        }
        let run_prompts_dir = project
            .join(".loop")
            .join("runs")
            .join(&run_id)
            .join("prompts");
        if !run_prompts_dir.is_dir() {
            return Err(format!(
                "run dir not initialized: {run_prompts_dir:?} (run loop_create_run first)"
            ));
        }
        let target = run_prompts_dir.join(&name);
        write_atomic(&target, &content)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Reads the run-local prompt at `<project>/.loop/runs/<run_id>/prompts/<name>`.
/// Returns the empty string if the file does not exist yet so the caller can
/// fall back to the global without an exception path.
#[tauri::command]
pub async fn loop_read_run_prompt(
    project_path: String,
    run_id: String,
    name: String,
) -> Result<String, String> {
    if !is_known_prompt(&name) {
        return Err(format!("unknown prompt: {name}"));
    }
    if !is_safe_run_id(&run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project_path is not a directory: {project_path}"));
        }
        let target = project
            .join(".loop")
            .join("runs")
            .join(&run_id)
            .join("prompts")
            .join(&name);
        match std::fs::read_to_string(&target) {
            Ok(s) => Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("could not read {target:?}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Overwrites the run-local prompt atomically. Used by Step 3 to materialize
/// inline edits before the scheduler starts — the scheduler reads the prompt
/// from the run dir on every agent invocation, so the override only takes
/// effect once this command has flushed the buffer to disk.
#[tauri::command]
pub async fn loop_write_run_prompt(
    project_path: String,
    run_id: String,
    name: String,
    content: String,
) -> Result<(), String> {
    if !is_known_prompt(&name) {
        return Err(format!("unknown prompt: {name}"));
    }
    if !is_safe_run_id(&run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project_path is not a directory: {project_path}"));
        }
        let run_prompts_dir = project
            .join(".loop")
            .join("runs")
            .join(&run_id)
            .join("prompts");
        if !run_prompts_dir.is_dir() {
            return Err(format!(
                "run dir not initialized: {run_prompts_dir:?} (run loop_create_run first)"
            ));
        }
        let target = run_prompts_dir.join(&name);
        write_atomic(&target, &content)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Writes the content of the given global prompt. The name must belong to the
/// canonical set — any other value returns an error without touching anything.
#[tauri::command]
pub async fn loop_write_global_prompt(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<(), String> {
    if !is_known_prompt(&name) {
        return Err(format!("unknown prompt: {name}"));
    }
    let dir = prompts_dir(&app)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
        let target = dir.join(&name);
        write_atomic(&target, &content)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

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

        for name in PROMPT_NAMES.iter() {
            let source = globals_dir.join(name);
            let content = match std::fs::read_to_string(&source) {
                Ok(c) => c,
                Err(_) => {
                    // If the global was deleted between the ensure and the
                    // copy, fall back to the bundled seed.
                    bundled_content(name)
                        .ok_or_else(|| format!("missing bundled seed for {name}"))?
                        .to_string()
                }
            };
            let dest = prompts_dir_run.join(name);
            write_atomic(&dest, &content)?;
        }

        Ok(CreatedRunPaths {
            run_dir: run_dir.to_string_lossy().to_string(),
            prompts_dir: prompts_dir_run.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn is_safe_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Allowed file names for `loop_read_run_file` / `loop_write_run_file`.
/// We only accept simple components (no separators) and restrict to the set
/// the run flow currently uses — `01-problem-draft.md` (chat auto-save),
/// `01-problem.md` (final consolidation), `02-phases.md` (step 2 phase
/// manifest — serialized JSON of `Phase[]`). We keep this restrictive on
/// purpose: the per-phase files (`logic.md`, `visual.html`) live in
/// subdirectories and have their own commands (`loop_*_phase_file`) below.
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

// ---------------------------------------------------------------------------
// Section 5: commands for step 2 phases
// ---------------------------------------------------------------------------
//
// Step 2 creates `<run>/phases/<NN>-<slug>/` for each phase in the manifest.
// Each subdir contains `logic.md` (always) and optionally `visual.html`. The
// frontend operations (create, list, read/write content, delete) go through
// these commands to keep path validation centralized (we do not expose a
// generic FS channel to the webview).
//
// Decisions:
// - We sanitize `phaseSlug` with the same predicate as `run_id`: only
//   `[A-Za-z0-9_-]`. The frontend generates slugs like `01-init`, `02-render`.
// - We only allow `logic.md` and `visual.html` as per-phase files.
// - `loop_list_phase_dirs` returns the subdirs sorted so the UI does not
//   need to guess the order — it just reflects what is on disk. The topology
//   (depends_on) is managed by the frontend by reading `02-phases.md`.

const ALLOWED_PHASE_FILES: &[&str] = &["logic.md", "visual.html"];

fn is_allowed_phase_file(name: &str) -> bool {
    ALLOWED_PHASE_FILES.contains(&name)
}

fn is_safe_phase_slug(slug: &str) -> bool {
    // Same rules as `run_id`: no traversal, no separators. The frontend
    // builds slugs like "01-init", "02-data-shape".
    is_safe_run_id(slug)
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

fn file_has_content(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(m) => m.is_file() && m.len() > 0,
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Section 7: outputs/<phase>/<agent>.{md,diff}, state.json, git diff snapshots
// ---------------------------------------------------------------------------
//
// The sequential step 3 engine (run-scheduler.ts) persists the outputs of
// each agent and a snapshot of the FS diff before/after each agent. The
// structure is `<run>/outputs/<phase_slug>/<agent>.<ext>` where `agent` is
// in `ALLOWED_OUTPUT_AGENTS` and `ext` is `md` or `diff`. In addition, the
// full run saves its serializable state in `<run>/state.json` (atomically
// rotated for resume — Section 9 extends the schema).
//
// Decisions:
// - Strict allowlist of agents and extensions — same reasoning as the other
//   commands (we do not open a generic FS channel to the webview).
// - We run `git diff` via `git` in the project `cwd`. If the project is not
//   under git, we return `""` as the diff without error — the empty snapshot
//   is semantically correct ("there were no trackable changes").
// - The command combines `git diff` (working tree vs HEAD, including partial
//   untracked via `--no-index` is not scalable; we use `--stat` + `diff` and
//   list untracked separately for a useful view without flooding the output).

const ALLOWED_OUTPUT_AGENTS: &[&str] = &[
    "analysis",
    "implementation",
    "review",
    "knowledge",
    "integration",
];
const ALLOWED_OUTPUT_EXTENSIONS: &[&str] = &["md", "diff"];

fn is_allowed_output_agent(agent: &str) -> bool {
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
///
/// Decision: post-hoc snapshot instead of a real `git stash`. design.md
/// section "Unrestricted FS permissions + auditing" mentions stash, but a
/// real stash interferes with the user's working state. A `git diff HEAD`
/// captures the delta without moving files. If a truly side-effect-free
/// view is needed later, we can go back to stash with `push --include-untracked
/// --keep-index` + `pop`, but that is more invasive and degrades if the user
/// has queued changes.
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
            // exit != 0 can happen if there is no HEAD yet (a freshly init'd
            // repo). In that case we return an empty snapshot + note.
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
//
// The hybrid engine (`run-scheduler.ts`) runs phases in parallel batches and
// uses an integrator agent between each batch. The integrator consumes all
// the outputs/diffs of the batch and produces a consolidated `knowledge.md`
// that lives at `<run>/outputs/batches/batch-<N>/knowledge.md`. Section 8.6
// makes that knowledge an additional input for the next batch's phases — so
// the frontend needs read/write access to this path.
//
// Decision: we treat `batch-<N>` as a "slug" identical to the existing
// `phase_slug`s (same validation predicate). The extension is only `md` (the
// per-batch diffs are not materialized — the integrator references them per
// phase via `loop_read_output_file`).
//
// The `batch_id` is sanitized with `safe_run_id` (the frontend generates
// "batch-0", "batch-1", ...). The file name is restricted by the allowlist
// below.

const ALLOWED_BATCH_FILES: &[&str] = &["knowledge.md"];

fn is_allowed_batch_file(name: &str) -> bool {
    ALLOWED_BATCH_FILES.contains(&name)
}

/// Resolves `<run>/outputs/batches/<batch_id>/<file>`. Applies the same
/// validations as the rest of the module commands — `run_id` and `batch_id`
/// go through `is_safe_run_id`, `file` through `is_allowed_batch_file`. If
/// the `run_dir` does not exist it is an error; the batch dir is created
/// on-demand on write.
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

// Note: Section 8.4 (conflict detection between batch phases) does NOT need
// a dedicated command because the detection is done in TS over the diffs
// read via `loop_read_output_file`. We leave this note here in case someone
// in the future looks for where the `git diff --check` is implemented.

// ---------------------------------------------------------------------------
// Section 9: detection of interrupted runs
// ---------------------------------------------------------------------------
//
// When opening `/loop` on a project, we scan `<project>/.loop/runs/` looking
// for runs whose `state.json` has `status: "running"` and an old
// `lastHeartbeat` (> N×3 seconds, default N=5s => 15s). We report them to
// the frontend so it can show a "interrupted run detected · resume?" banner.
//
// Decision: we do the scan in Rust instead of exposing a generic `list_dirs`
// because (a) we read the `state.json` files partially and filter in the
// same IO pass, (b) we already have all the path validation machinery in
// this module, (c) we avoid exposing an FS channel without an allowlist.

/// Summary of an interrupted run found on disk. Enough for the banner to
/// show the run and let the user decide to "resume" or "archive".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedRun {
    /// run_id (last component of the path).
    pub run_id: String,
    /// Epoch ms timestamp of the last persisted heartbeat (0 if none).
    pub last_heartbeat: i64,
    /// Heartbeat age in milliseconds at scan time. For the UI.
    pub age_ms: i64,
}

/// Scans `<project>/.loop/runs/` looking for interrupted runs. A run counts
/// as interrupted if:
///   - `<run>/state.json` exists,
///   - the JSON has `status: "running"` (or `"paused"` with an old heartbeat
///     — a crash mid-transition can leave it in any active state),
///   - `lastHeartbeat` is old: `(now - lastHeartbeat) > stale_threshold_ms`.
///
/// `stale_threshold_ms` defaults to 15s (N=5s × 3) — matches the design.md
/// "heartbeat frequency".
///
/// The scan tolerates per-run errors: if a `state.json` is corrupt, we skip
/// it and continue with the rest.
#[tauri::command]
pub async fn loop_list_interrupted_runs(
    project_path: String,
    stale_threshold_ms: Option<i64>,
) -> Result<Vec<InterruptedRun>, String> {
    let threshold = stale_threshold_ms.unwrap_or(15_000).max(0);
    tokio::task::spawn_blocking(move || -> Result<Vec<InterruptedRun>, String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Ok(Vec::new());
        }
        let runs_dir = project.join(".loop").join("runs");
        let entries = match std::fs::read_dir(&runs_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("could not list {runs_dir:?}: {e}")),
        };
        let now = epoch_ms_now();
        let mut out: Vec<InterruptedRun> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let run_id = entry.file_name().to_string_lossy().to_string();
            if !is_safe_run_id(&run_id) {
                continue;
            }
            let state_path = path.join("state.json");
            let raw = match std::fs::read_to_string(&state_path) {
                Ok(s) => s,
                Err(_) => continue, // without state.json, this is not a recognizable interrupted run
            };
            // Tolerant parsing: we read only the fields we need for the gate
            // (status + lastHeartbeat). If the JSON is corrupt, we skip it
            // without raising.
            let parsed: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let status = parsed.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let is_active = matches!(status, "running" | "paused");
            if !is_active {
                continue;
            }
            let last_heartbeat = parsed
                .get("lastHeartbeat")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let age = if last_heartbeat > 0 {
                now - last_heartbeat
            } else {
                // No heartbeat is semantically the same as infinitely old
                // (probably a very early crash). We treat it as interrupted
                // if threshold > 0.
                i64::MAX
            };
            if age >= threshold {
                out.push(InterruptedRun {
                    run_id,
                    last_heartbeat,
                    age_ms: if age == i64::MAX { age } else { age.max(0) },
                });
            }
        }
        // Most recent first so the banner shows the most relevant one at
        // the top if there is more than one (rare but possible case).
        out.sort_by(|a, b| b.last_heartbeat.cmp(&a.last_heartbeat));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Lightweight summary of a run on disk. Used in the "previous runs" picker
/// of step 1: offers the user the ability to resume an old run (even one
/// where only the `01-problem.md` was consolidated without running the
/// scheduler).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    /// Epoch ms of the most recent file in the run (draft/consolidated/state).
    pub last_modified_ms: i64,
    pub has_draft: bool,
    pub has_consolidated: bool,
    pub has_phases: bool,
    /// First non-empty line of the consolidated (or draft) — for preview.
    pub preview: Option<String>,
}

/// Lists all the runs of the project under `<project>/.loop/runs/`. Tolerant
/// to per-run errors (a corrupt dir does not break the scan). Sorts by
/// `last_modified_ms` descending — most recent first.
#[tauri::command]
pub async fn loop_list_runs(project_path: String) -> Result<Vec<RunSummary>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<RunSummary>, String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Ok(Vec::new());
        }
        let runs_dir = project.join(".loop").join("runs");
        let entries = match std::fs::read_dir(&runs_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("could not list {runs_dir:?}: {e}")),
        };
        let mut out: Vec<RunSummary> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let run_id = entry.file_name().to_string_lossy().to_string();
            if !is_safe_run_id(&run_id) {
                continue;
            }
            let draft_path = path.join("01-problem-draft.md");
            let consolidated_path = path.join("01-problem.md");
            let phases_path = path.join("02-phases.md");
            let has_draft = draft_path.is_file();
            let has_consolidated = consolidated_path.is_file();
            let has_phases = phases_path.is_file();
            // Skip empty dirs (no recognizable artifact).
            if !has_draft && !has_consolidated && !has_phases {
                continue;
            }
            let last_modified_ms = newest_mtime_ms(&path).unwrap_or(0);
            let preview = if has_consolidated {
                first_meaningful_line(&consolidated_path)
            } else if has_draft {
                first_user_message_from_draft(&draft_path)
            } else {
                None
            };
            out.push(RunSummary {
                run_id,
                last_modified_ms,
                has_draft,
                has_consolidated,
                has_phases,
                preview,
            });
        }
        out.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn newest_mtime_ms(dir: &Path) -> Option<i64> {
    let mut newest: i64 = 0;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        let ms = match p.metadata().and_then(|m| m.modified()) {
            Ok(t) => t
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            Err(_) => 0,
        };
        if ms > newest {
            newest = ms;
        }
    }
    if newest == 0 {
        None
    } else {
        Some(newest)
    }
}

fn first_meaningful_line(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        return Some(truncate_preview(trimmed));
    }
    None
}

fn first_user_message_from_draft(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut in_user_section = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("### User") {
            in_user_section = true;
            continue;
        }
        if trimmed.starts_with("###") || trimmed.starts_with("##") {
            in_user_section = false;
            continue;
        }
        if in_user_section && !trimmed.is_empty() {
            return Some(truncate_preview(trimmed));
        }
    }
    None
}

fn truncate_preview(s: &str) -> String {
    const LIMIT: usize = 140;
    if s.chars().count() <= LIMIT {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(LIMIT).collect();
        out.push('…');
        out
    }
}

/// Archive a run: we move it from `<project>/.loop/runs/<id>/` to
/// `<project>/.loop/archived/<id>/`. The user invokes it from the resume
/// banner when they decide to discard an interrupted run without losing it
/// entirely — it stays accessible for manual auditing.
///
/// If the destination already exists (case of a prior archive with the same
/// id, which should not happen with UUID runIds but defensive) we add a
/// timestamp suffix.
#[tauri::command]
pub async fn loop_archive_run(project_path: String, run_id: String) -> Result<String, String> {
    if !is_safe_run_id(&run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project_path is not a directory: {project_path}"));
        }
        let source = project.join(".loop").join("runs").join(&run_id);
        if !source.is_dir() {
            return Err(format!("run does not exist: {source:?}"));
        }
        let archived_root = project.join(".loop").join("archived");
        std::fs::create_dir_all(&archived_root)
            .map_err(|e| format!("could not create {archived_root:?}: {e}"))?;
        let mut target = archived_root.join(&run_id);
        if target.exists() {
            let stamp = epoch_ms_now();
            target = archived_root.join(format!("{run_id}-{stamp}"));
        }
        std::fs::rename(&source, &target)
            .map_err(|e| format!("could not move {source:?} -> {target:?}: {e}"))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Deletes partial outputs of a run: `<agent>.md` files that do not have a
/// `<agent>.diff` companion. The presence of the `.diff` indicates the
/// scheduler finished processing the stage atomically — without it, the
/// `.md` is a partial output from an agent that crashed mid-flight and must
/// be re-executed.
///
/// About integrator outputs (`outputs/batches/<batch>/knowledge.md`): they
/// do not have a `.diff` companion, so we do not touch them here. The
/// scheduler summary regenerates them if the integrator has status != done.
#[tauri::command]
pub async fn loop_discard_partial_outputs(
    project_path: String,
    run_id: String,
) -> Result<Vec<String>, String> {
    if !is_safe_run_id(&run_id) {
        return Err(format!("invalid run_id: {run_id}"));
    }
    tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let project = PathBuf::from(&project_path);
        if !project.is_dir() {
            return Err(format!("project_path is not a directory: {project_path}"));
        }
        let outputs = project
            .join(".loop")
            .join("runs")
            .join(&run_id)
            .join("outputs");
        let phase_entries = match std::fs::read_dir(&outputs) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("could not list {outputs:?}: {e}")),
        };
        let mut discarded: Vec<String> = Vec::new();
        for phase_entry in phase_entries.flatten() {
            let phase_path = phase_entry.path();
            if !phase_path.is_dir() {
                continue;
            }
            // Skip the `batches/` subdir — its outputs do not have `.diff`.
            if phase_entry.file_name() == "batches" {
                continue;
            }
            let files = match std::fs::read_dir(&phase_path) {
                Ok(e) => e,
                Err(_) => continue,
            };
            // Map of available stems: agent name -> { has_md, has_diff }.
            let mut state: std::collections::HashMap<String, (bool, bool)> =
                std::collections::HashMap::new();
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if let Some(stem) = name.strip_suffix(".md") {
                    state.entry(stem.to_string()).or_default().0 = true;
                } else if let Some(stem) = name.strip_suffix(".diff") {
                    state.entry(stem.to_string()).or_default().1 = true;
                }
            }
            for (stem, (has_md, has_diff)) in state {
                if has_md && !has_diff && is_allowed_output_agent(&stem) {
                    let target = phase_path.join(format!("{stem}.md"));
                    if std::fs::remove_file(&target).is_ok() {
                        discarded.push(target.to_string_lossy().to_string());
                    }
                }
            }
        }
        Ok(discarded)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn epoch_ms_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Result of `loop_validate_cli_model`. `ok=true` => green slot. `ok=false`
/// with `reason` readable to show the user (e.g. "claude not found in PATH",
/// "model not available: 404").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliValidation {
    pub ok: bool,
    pub reason: Option<String>,
}

impl CliValidation {
    fn ok() -> Self {
        Self {
            ok: true,
            reason: None,
        }
    }
    fn err(reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            reason: Some(reason.into()),
        }
    }
}

/// Checks that the CLI binary is reachable in PATH by invoking `<cli> --version`.
///
/// We deliberately do NOT ping the model with a real prompt: that used to fire
/// a billable round-trip per slot validation (and per Step 3 re-render), and
/// the subprocess could not be cancelled because the previous implementation
/// wrapped a synchronous `std::process::Command::output` inside
/// `spawn_blocking` with `tokio::time::timeout` on the join handle — which
/// only abandons the thread and leaves the CLI process running. Model name
/// typos surface naturally on the first agent invocation; the trade-off is
/// that a slot stays "ok" in the UI until the run actually starts, but no
/// money is spent and no subprocess can be orphaned.
///
/// We use `tokio::process::Command` with `kill_on_drop(true)` so a hung
/// `--version` (rare but possible on a broken shim) is actually killed when
/// the 10s timeout elapses, rather than orphaned.
#[tauri::command]
pub async fn loop_validate_cli_model(cli: String, _model: String) -> Result<CliValidation, String> {
    let cli_lower = cli.to_ascii_lowercase();
    if !matches!(cli_lower.as_str(), "claude" | "codex" | "opencode") {
        return Ok(CliValidation::err(format!("unsupported CLI: {cli}")));
    }

    let mut cmd = TokioCommand::new(&cli_lower);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CliValidation::err(format!("{cli_lower} not found in PATH")));
        }
        Err(e) => {
            return Ok(CliValidation::err(format!(
                "error invoking {cli_lower}: {e}"
            )));
        }
    };

    match tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => Ok(CliValidation::ok()),
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let snippet = stderr.lines().next().unwrap_or("").trim();
            Ok(CliValidation::err(format!(
                "{cli_lower} --version exit {}: {snippet}",
                out.status
            )))
        }
        Ok(Err(e)) => Ok(CliValidation::err(format!(
            "error waiting on {cli_lower}: {e}"
        ))),
        Err(_) => Ok(CliValidation::err("validation timeout")),
    }
}

/// Writes `content` to `target` atomically: temp file in the same dir,
/// optional fsync, rename. If it fails at any step, it does not leave
/// partial files where there used to be a valid one. We do not use
/// `tempfile::NamedTempFile` here because its API to move to another dir is
/// not atomic across filesystems — this version keeps everything in the
/// destination dir.
fn write_atomic(target: &Path, content: &str) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("path without parent dir: {target:?}"))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;

    let tmp = parent.join(format!(
        ".{}.tmp",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("prompt")
    ));

    std::fs::write(&tmp, content).map_err(|e| format!("could not write tmp {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, target).map_err(|e| {
        // Best-effort cleanup.
        let _ = std::fs::remove_file(&tmp);
        format!("could not rename {tmp:?} -> {target:?}: {e}")
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_content_covers_all_7() {
        for name in PROMPT_NAMES.iter() {
            let content = bundled_content(name).expect("bundled missing");
            assert!(!content.is_empty(), "bundled empty for {name}");
        }
    }

    #[test]
    fn bundled_content_rejects_unknown() {
        assert!(bundled_content("anything-else.md").is_none());
    }

    #[test]
    fn safe_run_id_accepts_alphanumeric_dashes_underscores() {
        assert!(is_safe_run_id("run-2026-06-24"));
        assert!(is_safe_run_id("abc_123"));
        assert!(is_safe_run_id("a"));
    }

    #[test]
    fn safe_run_id_rejects_traversal_and_separators() {
        assert!(!is_safe_run_id(""));
        assert!(!is_safe_run_id(".."));
        assert!(!is_safe_run_id("a/b"));
        assert!(!is_safe_run_id("a b"));
        assert!(!is_safe_run_id("a.b"));
        assert!(!is_safe_run_id(&"a".repeat(200)));
    }

    #[test]
    fn ensure_dir_creates_missing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("prompts");
        let restored = ensure_dir_sync(&dir).unwrap();
        assert_eq!(restored.len(), PROMPT_NAMES.len());
        for name in PROMPT_NAMES.iter() {
            assert!(dir.join(name).exists(), "{name} was not restored");
        }
    }

    #[test]
    fn ensure_dir_does_not_overwrite_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("prompts");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("analysis.md"), "MY EDIT").unwrap();

        let restored = ensure_dir_sync(&dir).unwrap();
        // 6 files restored, not the edited one.
        assert_eq!(restored.len(), PROMPT_NAMES.len() - 1);
        assert!(!restored.contains(&"analysis.md".to_string()));
        assert_eq!(
            std::fs::read_to_string(dir.join("analysis.md")).unwrap(),
            "MY EDIT"
        );
    }

    #[test]
    fn write_atomic_creates_target_and_no_tmp_remainder() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("hello.md");
        write_atomic(&target, "content").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "content");

        // No orphan .tmp files should be left in the dir.
        let leftovers = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .count();
        assert_eq!(leftovers, 0);
    }
}
