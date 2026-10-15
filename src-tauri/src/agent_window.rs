use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

// The bottom panel's agent tab moved into its own native window.
//
// The agent's PTY keeps running across the move; this only keeps what the new
// window needs to pick it up, and tells the main window once the window is
// gone so the tab takes the agent back.

pub const LABEL: &str = "agent";
pub const CLOSED_EVENT: &str = "agent-window:closed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWindowState {
    /// Where to open, in screen coordinates; the pointer when the tab is dropped.
    #[serde(default)]
    pub position: Option<(f64, f64)>,
    /// Opaque to Rust: the CLI and the running session the window adopts.
    pub payload: serde_json::Value,
}

#[derive(Default)]
pub struct AgentWindow {
    state: Mutex<Option<AgentWindowState>>,
}

fn focus(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
pub fn agent_window_open(
    app: AppHandle,
    windows: tauri::State<'_, AgentWindow>,
    state: AgentWindowState,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        focus(&existing);
        return Ok(());
    }
    *windows.state.lock() = Some(state.clone());
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App("agent.html".into()))
            .title("agent — polakapi")
            .inner_size(900.0, 600.0)
            .min_inner_size(420.0, 260.0)
            .background_color(tauri::window::Color(0x0d, 0x0d, 0x10, 0xff));
    if let Some((x, y)) = state.position {
        builder = builder.position(x, y);
    }
    if let Err(e) = builder.build() {
        *windows.state.lock() = None;
        return Err(format!("could not open the agent window: {e}"));
    }
    Ok(())
}

/// What the agent window should adopt. Only the agent window may ask.
#[tauri::command]
pub fn agent_window_state(
    window: tauri::Window,
    windows: tauri::State<'_, AgentWindow>,
) -> Result<AgentWindowState, String> {
    if window.label() != LABEL {
        return Err("not the agent window".into());
    }
    windows
        .state
        .lock()
        .clone()
        .ok_or_else(|| "no state for the agent window".to_string())
}

/// Brings the window to the front. False when it does not exist.
#[tauri::command]
pub fn agent_window_focus(app: AppHandle) -> bool {
    match app.get_webview_window(LABEL) {
        Some(window) => {
            focus(&window);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn agent_window_close(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called from the app's window-event hook once the agent window is destroyed.
pub fn on_destroyed(app: &AppHandle, windows: &AgentWindow, label: &str) {
    if label != LABEL {
        return;
    }
    *windows.state.lock() = None;
    let _ = app.emit_to("main", CLOSED_EVENT, ());
}
