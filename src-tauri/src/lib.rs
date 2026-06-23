// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod fs;
mod pty;

use std::sync::Arc;
use tauri::Manager;

use crate::commands::{fs_validate_path, pty_kill, pty_resize, pty_spawn, pty_write};
use crate::pty::PtyStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            fs_validate_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
