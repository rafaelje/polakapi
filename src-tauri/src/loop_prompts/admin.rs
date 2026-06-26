//! Run discovery + lifecycle admin: list interrupted runs (for the resume
//! banner), list all runs (for the "previous runs" picker), archive a run,
//! discard partial outputs after a crash, and CLI/model validation.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command as TokioCommand;

use super::storage::is_allowed_output_agent;
use super::{epoch_ms_now, is_safe_run_id};

// ---------------------------------------------------------------------------
// Section 9: detection of interrupted runs
// ---------------------------------------------------------------------------

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
/// as interrupted if `state.json` says `running`/`paused` and `lastHeartbeat`
/// is older than `stale_threshold_ms` (default 15s = N=5s × 3).
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
                Err(_) => continue,
            };
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
                // (probably a very early crash).
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
        out.sort_by_key(|r| std::cmp::Reverse(r.last_heartbeat));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    /// Epoch ms of the most recent file in the run.
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
        out.sort_by_key(|r| std::cmp::Reverse(r.last_modified_ms));
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

/// Archive a run: move it from `<project>/.loop/runs/<id>/` to
/// `<project>/.loop/archived/<id>/`. If the destination already exists we
/// add a timestamp suffix.
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

// ---------------------------------------------------------------------------
// Section 10: CLI / model validation
// ---------------------------------------------------------------------------

/// Result of `loop_validate_cli_model`. `ok=true` => green slot. `ok=false`
/// with `reason` readable to show the user.
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

/// Checks that the CLI binary is reachable in PATH by invoking `<cli>
/// --version`.
///
/// We deliberately do NOT ping the model with a real prompt: that used to
/// fire a billable round-trip per slot validation (and per Step 3
/// re-render), and the subprocess could not be cancelled because the
/// previous implementation wrapped a synchronous `Command::output` inside
/// `spawn_blocking` with `tokio::time::timeout` on the join handle — which
/// only abandons the thread and leaves the CLI process running. Model name
/// typos surface naturally on the first agent invocation; the trade-off is
/// that a slot stays "ok" in the UI until the run actually starts, but no
/// money is spent and no subprocess can be orphaned.
///
/// We use `tokio::process::Command` with `kill_on_drop(true)` so a hung
/// `--version` (rare but possible on a broken shim) is actually killed
/// when the 10s timeout elapses, rather than orphaned.
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
