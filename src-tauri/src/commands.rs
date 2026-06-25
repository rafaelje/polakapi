use crate::fs::validate_path;
use crate::pty::{spawn_session, PtyStore};
use portable_pty::PtySize;
use std::io::Write;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Max bytes accepted in a single `pty_write` call. Guards against memory
/// exhaustion from a malicious or runaway frontend loop. 256 KiB is well above
/// any legitimate keystroke / paste while keeping the writer responsive.
const MAX_WRITE_BYTES: usize = 256 * 1024;

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    store: State<'_, Arc<PtyStore>>,
    cols: u16,
    rows: u16,
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<String, String> {
    spawn_session(app, (*store).clone(), cols, rows, command, args, cwd)
}

#[tauri::command]
pub fn pty_write(store: State<'_, Arc<PtyStore>>, id: String, data: String) -> Result<(), String> {
    if data.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "pty_write payload too large: {} bytes (max {MAX_WRITE_BYTES})",
            data.len()
        ));
    }
    let session = store
        .session(&id)
        .ok_or_else(|| format!("unknown pty: {id}"))?;
    let mut writer = session.writer.lock();
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    store: State<'_, Arc<PtyStore>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = store
        .session(&id)
        .ok_or_else(|| format!("unknown pty: {id}"))?;
    let result = session.master.lock().resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(store: State<'_, Arc<PtyStore>>, id: String) -> Result<(), String> {
    store.kill_session(&id);
    Ok(())
}

/// Validates a filesystem path on behalf of the workspaces module.
///
/// Returns `Ok(())` if the path exists, is a directory and is readable by the
/// current process. On failure, returns a stable string consumed by
/// `path-validation.ts`: `"not_found" | "not_directory" | "not_readable" |
/// "unknown:<msg>"`.
#[tauri::command]
pub fn fs_validate_path(path: String) -> Result<(), String> {
    validate_path(&path).map_err(|err| err.as_contract_string())
}

/// Opens `path` in the OS file manager (Finder / Explorer / xdg-open).
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    crate::open::open_in_explorer(&path)
}

/// Opens `path` in an editor. When `editor` is `None`, the first available
/// binary from the fallback order (agy-ide, code) is used.
#[tauri::command]
pub fn open_in_editor(path: String, editor: Option<String>) -> Result<(), String> {
    crate::open::open_in_editor(&path, editor.as_deref())
}

/// Opens a single file `path` in an editor. Same resolver as
/// [`open_in_editor`], but accepts files (not directories).
#[tauri::command]
pub fn open_file_in_editor(path: String, editor: Option<String>) -> Result<(), String> {
    crate::open::open_file_in_editor(&path, editor.as_deref())
}
