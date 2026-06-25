//! Global prompts (`<app-config>/prompts/<name>.md`) and the per-run copies
//! (`<project>/.loop/runs/<run_id>/prompts/<name>.md`).
//!
//! Frontends edit globals (which persist across runs) and per-run overrides
//! (which only affect the current run). The scheduler always reads the
//! per-run copy when invoking an agent — `loop_create_run` materializes it
//! atomically from the global at run creation time.

use std::path::PathBuf;

use super::{
    bundled_content, ensure_dir_sync, is_known_prompt, is_safe_run_id, prompts_dir, write_atomic,
};

#[tauri::command]
pub async fn loop_ensure_prompts_dir(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = prompts_dir(&app)?;
    tokio::task::spawn_blocking(move || ensure_dir_sync(&dir))
        .await
        .map_err(|e| format!("join error: {e}"))?
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
