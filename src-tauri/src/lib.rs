// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod capture;
mod commands;
pub mod db;
mod fs;
mod loop_cli;
mod loop_prompts;
mod open;
mod pty;

use std::sync::{Arc, Mutex};
use tauri::Manager;

use crate::db::Db;

use crate::commands::{
    app_exit, fs_validate_path, open_file_in_editor, open_in_editor, open_in_explorer,
    open_in_shell, pty_kill, pty_resize, pty_spawn, pty_write,
};
use crate::db::{
    prompt_delete_sessions, prompt_get, prompt_install_hooks, prompt_list_by_session,
    prompt_list_sessions, prompt_search,
};
use crate::loop_cli::run_loop_agent;
use crate::loop_prompts::{
    loop_archive_run, loop_create_phase_dir, loop_create_run, loop_delete_phase_dir,
    loop_discard_partial_outputs, loop_ensure_prompts_dir, loop_ensure_run_prompt,
    loop_git_diff_snapshot, loop_list_interrupted_runs, loop_list_phase_dirs, loop_list_runs,
    loop_read_batch_file, loop_read_global_prompt, loop_read_output_file, loop_read_phase_file,
    loop_read_run_file, loop_read_run_prompt, loop_read_state_file, loop_reseed_global_prompt,
    loop_reset_run_prompt_to_global, loop_validate_cli_model, loop_write_batch_file,
    loop_write_global_prompt, loop_write_output_file, loop_write_phase_file, loop_write_run_file,
    loop_write_run_prompt, loop_write_state_file,
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
                // Open the prompts history DB at <app_config_dir>/polakapi.db
                // and register it as `State<Mutex<Db>>` for the read commands.
                // If opening fails we still boot the app — the read commands
                // will return errors and the capture helper keeps writing
                // via its own connection.
                match Db::resolve_path(app.handle()) {
                    Ok(path) => match Db::open(&path) {
                        Ok(db) => {
                            app.manage(Mutex::new(db));
                        }
                        Err(e) => {
                            eprintln!(
                                "polakapi: could not open prompts DB at {}: {e}",
                                path.display()
                            );
                        }
                    },
                    Err(e) => {
                        eprintln!("polakapi: could not resolve prompts DB path: {e}");
                    }
                }
                Ok(())
            }
        })
        .on_window_event({
            let store = store.clone();
            move |window, event| {
                if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                    store.kill_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            app_exit,
            fs_validate_path,
            open_in_explorer,
            open_in_editor,
            open_in_shell,
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
            loop_reseed_global_prompt,
            loop_ensure_run_prompt,
            loop_read_run_prompt,
            loop_write_run_prompt,
            loop_archive_run,
            loop_discard_partial_outputs,
            prompt_list_sessions,
            prompt_list_by_session,
            prompt_get,
            prompt_search,
            prompt_delete_sessions,
            prompt_install_hooks
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
