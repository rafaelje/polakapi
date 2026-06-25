// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod fs;
mod loop_cli;
mod loop_prompts;
mod open;
mod pty;

use std::sync::Arc;
use tauri::Manager;

use crate::commands::{
    fs_validate_path, open_file_in_editor, open_in_editor, open_in_explorer, pty_kill, pty_resize,
    pty_spawn, pty_write,
};
use crate::loop_cli::run_loop_agent;
use crate::loop_prompts::{
    loop_archive_run, loop_create_phase_dir, loop_create_run, loop_delete_phase_dir,
    loop_discard_partial_outputs, loop_ensure_prompts_dir, loop_git_diff_snapshot,
    loop_list_interrupted_runs, loop_list_phase_dirs, loop_list_runs, loop_read_batch_file,
    loop_reset_run_prompt_to_global,
    loop_read_global_prompt, loop_read_output_file, loop_read_phase_file, loop_read_run_file,
    loop_read_state_file, loop_validate_cli_model, loop_write_batch_file,
    loop_write_global_prompt, loop_write_output_file, loop_write_phase_file, loop_write_run_file,
    loop_write_state_file,
};
use crate::pty::PtyStore;

/// macOS launches `.app` bundles with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
/// so binaries under `/opt/homebrew/bin`, `~/.npm-global/bin`, NVM shims, etc. are
/// invisible to spawned PTYs. Shell out once to the user's login shell, capture the
/// real PATH and overwrite the process env so portable_pty can find tools like
/// `claude`, `codex`, `opencode`. No-op on Windows. When launched from a terminal
/// PATH is already rich; the import is still cheap (~50ms) and idempotent.
#[cfg(not(target_os = "windows"))]
fn import_user_path() {
    let shell = match std::env::var("SHELL") {
        Ok(s) if !s.is_empty() => s,
        _ => return,
    };
    let Ok(out) = std::process::Command::new(&shell)
        .args(["-ilc", "printf %s \"$PATH\""])
        .output()
    else {
        return;
    };
    if !out.status.success() {
        return;
    }
    let Ok(path) = String::from_utf8(out.stdout) else {
        return;
    };
    let trimmed = path.trim();
    if !trimmed.is_empty() && !trimmed.contains('\0') {
        std::env::set_var("PATH", trimmed);
    }
}

#[cfg(target_os = "windows")]
fn import_user_path() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    import_user_path();
    let store: Arc<PtyStore> = Arc::new(PtyStore::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup({
            let store = store.clone();
            move |app| {
                app.manage(store);
                Ok(())
            }
        })
        .on_window_event({
            let store = store.clone();
            move |_window, event| {
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    store.kill_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            fs_validate_path,
            open_in_explorer,
            open_in_editor,
            open_file_in_editor,
            run_loop_agent,
            loop_ensure_prompts_dir,
            loop_read_global_prompt,
            loop_write_global_prompt,
            loop_create_run,
            loop_validate_cli_model,
            loop_read_run_file,
            loop_write_run_file,
            loop_create_phase_dir,
            loop_delete_phase_dir,
            loop_read_phase_file,
            loop_write_phase_file,
            loop_list_phase_dirs,
            loop_read_output_file,
            loop_write_output_file,
            loop_read_state_file,
            loop_write_state_file,
            loop_git_diff_snapshot,
            loop_read_batch_file,
            loop_write_batch_file,
            loop_list_interrupted_runs,
            loop_list_runs,
            loop_reset_run_prompt_to_global,
            loop_archive_run,
            loop_discard_partial_outputs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
