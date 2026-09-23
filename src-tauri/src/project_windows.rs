use std::collections::HashMap;
use std::time::Instant;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

// A project's terminal grid moved into its own native window.
//
// The main window stays the owner of the project and of persistence; this
// only keeps what the new window needs to build itself, and answers "bring
// that window to the front". Focus is done here rather than in the webview
// because the window setters are not in `core:default`, and a Rust command
// needs no capability at all.

const LABEL_PREFIX: &str = "project-";
pub const CLOSED_EVENT: &str = "project-window:closed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWindowState {
    pub project_id: String,
    pub title: String,
    /// Opaque to Rust: the terminal specs and layout the window rebuilds.
    pub payload: serde_json::Value,
}

#[derive(Default)]
pub struct ProjectWindows {
    windows: Mutex<HashMap<String, ProjectWindowState>>,
    /// When each window was requested, to report how long it took to be usable.
    opened_at: Mutex<HashMap<String, Instant>>,
}

/// What the window measured on its side, in milliseconds.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyTimings {
    pub script_started: f64,
    pub state_loaded: f64,
    pub panes_adopted: f64,
    pub panes: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedPayload {
    pub project_id: String,
}

pub fn label_for(project_id: &str) -> String {
    format!("{LABEL_PREFIX}{project_id}")
}

pub fn is_project_window(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

fn focus(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
pub fn project_window_open(
    app: AppHandle,
    windows: tauri::State<'_, ProjectWindows>,
    state: ProjectWindowState,
) -> Result<(), String> {
    if state.project_id.is_empty() || state.project_id.contains(['/', '\\']) {
        return Err("invalid project id".into());
    }
    let label = label_for(&state.project_id);
    windows.windows.lock().insert(label.clone(), state.clone());
    windows
        .opened_at
        .lock()
        .insert(label.clone(), Instant::now());
    if let Some(existing) = app.get_webview_window(&label) {
        focus(&existing);
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("terminals.html".into()),
    )
    .title(format!("{} — polakapi", state.title))
    .inner_size(1100.0, 720.0)
    .min_inner_size(480.0, 320.0)
    // The app's own background, so the window is dark from the first frame
    // instead of flashing white until the stylesheet arrives.
    .background_color(tauri::window::Color(0x0d, 0x0d, 0x10, 0xff))
    .build()
    .map_err(|e| format!("could not open project window: {e}"))?;
    Ok(())
}

/// What the calling window should build. Only a project window may ask, and
/// only for itself.
#[tauri::command]
pub fn project_window_state(
    window: tauri::Window,
    windows: tauri::State<'_, ProjectWindows>,
) -> Result<ProjectWindowState, String> {
    let label = window.label();
    if !is_project_window(label) {
        return Err("not a project window".into());
    }
    windows
        .windows
        .lock()
        .get(label)
        .cloned()
        .ok_or_else(|| format!("no state for {label}"))
}

/// The window has rendered its grid. Prints one line with where the time went,
/// so a slow start can be attributed instead of guessed at.
#[tauri::command]
pub fn project_window_ready(
    window: tauri::Window,
    windows: tauri::State<'_, ProjectWindows>,
    timings: ReadyTimings,
) {
    let Some(opened) = windows.opened_at.lock().remove(window.label()) else {
        return;
    };
    let total = opened.elapsed().as_millis();
    eprintln!(
        "polakapi: project window {} ready in {total} ms — webview up and script running \
         after {:.0} ms, state fetched +{:.0} ms, {} pane(s) adopted +{:.0} ms",
        window.label(),
        timings.script_started,
        timings.state_loaded - timings.script_started,
        timings.panes,
        timings.panes_adopted - timings.state_loaded,
    );
}

/// Brings the project's window to the front. False when it has no window.
#[tauri::command]
pub fn project_window_focus(app: AppHandle, project_id: String) -> bool {
    match app.get_webview_window(&label_for(&project_id)) {
        Some(window) => {
            focus(&window);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn project_window_close(app: AppHandle, project_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label_for(&project_id)) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called from the app's window-event hook: forgets a destroyed window and
/// tells the main window, which then takes the grid back.
pub fn on_destroyed(app: &AppHandle, windows: &ProjectWindows, label: &str) {
    if !is_project_window(label) {
        return;
    }
    let state = windows.windows.lock().remove(label);
    let project_id = state
        .map(|s| s.project_id)
        .unwrap_or_else(|| label[LABEL_PREFIX.len()..].to_string());
    let _ = app.emit_to("main", CLOSED_EVENT, ClosedPayload { project_id });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_derived_from_the_project_id_and_recognised() {
        assert_eq!(label_for("abc-123"), "project-abc-123");
        assert!(is_project_window("project-abc-123"));
        assert!(!is_project_window("main"));
        assert!(!is_project_window("settings"));
    }
}
