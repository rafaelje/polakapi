//! Management of the 7 global prompts and the `/loop` runs.
//!
//! The Tauri commands live in sibling modules under `loop_prompts/`:
//!
//! - [`globals`]: global prompts + per-run prompt copies (`<run>/prompts/`).
//! - [`runs`]: run lifecycle — create the tree and read/write the
//!   per-run manifest files (`01-problem-draft.md`, `01-problem.md`,
//!   `02-phases.md`).
//! - [`storage`]: per-phase files (`logic.md`/`visual.html`), per-agent
//!   outputs (`outputs/<phase>/<agent>.{md,diff}`), `state.json`,
//!   per-batch consolidated knowledge, and the git diff snapshot helper.
//! - [`admin`]: run discovery (interrupted runs banner, "previous runs"
//!   picker), archive + discard-partial-outputs, and CLI/model validation.
//!
//! This file owns the shared helpers (`write_atomic`, `is_safe_run_id`,
//! `prompts_dir`, ...) and the bundled prompt seeds (`include_str!`). It
//! re-exports the public command surface so `lib.rs` keeps importing from
//! `crate::loop_prompts`.
//!
//! Decision: bundling via `include_str!`. It is the simplest pattern with
//! no new dependencies; the binary grows ~10KB (the 7 .md files combined),
//! nothing compared with the overhead of registering them as Tauri
//! resources and reading them at runtime.

use std::path::{Path, PathBuf};

use tauri::Manager;

mod admin;
mod globals;
mod runs;
mod storage;

pub use admin::{
    loop_archive_run, loop_discard_partial_outputs, loop_list_interrupted_runs, loop_list_runs,
    loop_validate_cli_model,
};
pub use globals::{
    loop_ensure_prompts_dir, loop_ensure_run_prompt, loop_read_global_prompt, loop_read_run_prompt,
    loop_reseed_global_prompt, loop_reset_run_prompt_to_global, loop_write_global_prompt,
    loop_write_run_prompt,
};
pub use runs::{loop_create_run, loop_read_run_file, loop_write_run_file};
pub use storage::{
    loop_create_phase_dir, loop_delete_phase_dir, loop_git_diff_snapshot, loop_list_phase_dirs,
    loop_read_batch_file, loop_read_output_file, loop_read_phase_file, loop_read_state_file,
    loop_write_batch_file, loop_write_output_file, loop_write_phase_file, loop_write_state_file,
};

/// The 7 canonical prompt names. Any other name is rejected by
/// `loop_read_global_prompt` / `loop_write_global_prompt`. We keep this
/// constant as the single source of truth so that a typo in TS does not
/// produce orphan files.
pub(crate) const PROMPT_NAMES: [&str; 7] = [
    "problem-intake.md",
    "phase-decomposition.md",
    "analysis.md",
    "implementation.md",
    "review.md",
    "knowledge.md",
    "integration.md",
];

/// Bundled content of each prompt. Embedded with `include_str!` from
/// `src-tauri/prompts/` at build time — if any of those files does not
/// exist the build fails.
pub(crate) fn bundled_content(name: &str) -> Option<&'static str> {
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

pub(crate) fn is_known_prompt(name: &str) -> bool {
    PROMPT_NAMES.contains(&name)
}

/// Returns `<app-config>/prompts/` resolving the config dir from the app
/// handle.
pub(crate) fn prompts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app_config_dir: {e}"))?;
    Ok(base.join("prompts"))
}

/// Creates `<app-config>/prompts/` (if needed) and restores every missing
/// file from the bundled set. Does not overwrite existing files — only
/// creates the missing ones. Returns the names that were restored.
pub(crate) fn ensure_dir_sync(dir: &Path) -> Result<Vec<String>, String> {
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

pub(crate) fn is_safe_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The frontend builds slugs like "01-init", "02-data-shape" — same rules
/// as `run_id`: no traversal, no separators.
pub(crate) fn is_safe_phase_slug(slug: &str) -> bool {
    is_safe_run_id(slug)
}

pub(crate) fn file_has_content(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(m) => m.is_file() && m.len() > 0,
        Err(_) => false,
    }
}

pub(crate) fn epoch_ms_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Writes `content` to `target` atomically: temp file in the same dir,
/// optional fsync, rename. If it fails at any step, it does not leave
/// partial files where there used to be a valid one. We do not use
/// `tempfile::NamedTempFile` here because its API to move to another dir
/// is not atomic across filesystems — this version keeps everything in
/// the destination dir.
pub(crate) fn write_atomic(target: &Path, content: &str) -> Result<(), String> {
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
