use crate::pty::{spawn_session, PtyStore};
use portable_pty::PtySize;
use std::io::Write;
use std::sync::Arc;
use tauri::{AppHandle, State};

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
    let mut sessions = store.sessions.lock();
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("unknown pty: {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    store: State<'_, Arc<PtyStore>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = store.sessions.lock();
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("unknown pty: {id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(store: State<'_, Arc<PtyStore>>, id: String) -> Result<(), String> {
    let mut sessions = store.sessions.lock();
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}
