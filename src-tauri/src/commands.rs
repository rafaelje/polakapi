use crate::fs::validate_path;
use crate::open::ShellRegistry;
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

#[tauri::command]
pub fn app_exit(app: AppHandle, store: State<'_, Arc<PtyStore>>) -> Result<(), String> {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(750));
        std::process::exit(0);
    });
    store.kill_all();
    app.exit(0);
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

/// Creates `parent/name` on disk and returns the new absolute path.
#[tauri::command]
pub fn fs_create_folder(parent: String, name: String) -> Result<String, String> {
    let parent_path = std::path::Path::new(&parent);
    if !parent_path.is_dir() {
        return Err(format!("parent is not a directory: {parent}"));
    }
    let name = name.trim();
    if !is_valid_folder_name(name) {
        return Err(format!("invalid folder name: {name}"));
    }
    let dest = parent_path.join(name);
    if dest.exists() {
        return Err(format!("already exists: {}", dest.display()));
    }
    std::fs::create_dir(&dest).map_err(|e| format!("could not create {}: {e}", dest.display()))?;
    Ok(dest.to_string_lossy().to_string())
}

fn is_valid_folder_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
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

/// Launches an external Ghostty terminal window with `path` as the working
/// directory. If a window is already open for that path it is reused.
#[tauri::command]
pub fn open_in_shell(shell: State<'_, ShellRegistry>, path: String) -> Result<(), String> {
    crate::open::open_in_shell(&shell, &path)
}

/// Opens a single file `path` in an editor. Same resolver as
/// [`open_in_editor`], but accepts files (not directories).
#[tauri::command]
pub fn open_file_in_editor(path: String, editor: Option<String>) -> Result<(), String> {
    crate::open::open_file_in_editor(&path, editor.as_deref())
}

/// Opens an http(s) URL in the system browser. Non-web schemes are rejected.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    crate::open::open_url(&url)
}

/// Opens a local path clicked in a terminal: directories in the file manager,
/// files in the editor.
#[tauri::command]
pub fn open_local_path(path: String) -> Result<(), String> {
    crate::open::open_local_path(&path)
}
