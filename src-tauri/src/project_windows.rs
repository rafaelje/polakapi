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
    /// Names the window: the project id for a whole grid, or
    /// `<project id>--<pty id>` for a single terminal torn off it.
    pub window_id: String,
    pub project_id: String,
    pub title: String,
    /// Where to open, in screen coordinates; the pointer when a pane is dropped.
    #[serde(default)]
    pub position: Option<(f64, f64)>,
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
    #[serde(default)]
    pub html_received: f64,
    #[serde(default)]
    pub dom_loaded: f64,
    #[serde(default)]
    pub resources: u32,
    #[serde(default)]
    pub slowest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedPayload {
    pub window_id: String,
}

pub fn label_for(window_id: &str) -> String {
    format!("{LABEL_PREFIX}{window_id}")
}

/// Ids become window labels; keep them to the characters labels allow.
fn is_valid_window_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
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
    if !is_valid_window_id(&state.window_id) {
        return Err("invalid window id".into());
    }
    let label = label_for(&state.window_id);
    windows.windows.lock().insert(label.clone(), state.clone());
    windows
        .opened_at
        .lock()
        .insert(label.clone(), Instant::now());
    if let Some(existing) = app.get_webview_window(&label) {
        focus(&existing);
        return Ok(());
    }
    let single_pane = state.window_id != state.project_id;
    let (width, height) = if single_pane {
        (760.0, 480.0)
    } else {
        (1100.0, 720.0)
    };
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("terminals.html".into()),
    )
    .title(format!("{} — polakapi", state.title))
    .inner_size(width, height)
    .min_inner_size(360.0, 240.0)
    // The app's own background, so the window is dark from the first frame
    // instead of flashing white until the stylesheet arrives.
    .background_color(tauri::window::Color(0x0d, 0x0d, 0x10, 0xff));
    if let Some((x, y)) = state.position {
        builder = builder.position(x, y);
    }
    builder
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
        "polakapi: project window {} ready in {total} ms — html at {:.0} ms, script running \
         at {:.0} ms, DOM loaded at {:.0} ms ({} resources; slowest: {}), state fetched \
         +{:.0} ms, {} pane(s) adopted +{:.0} ms",
        window.label(),
        timings.html_received,
        timings.script_started,
        timings.dom_loaded,
        timings.resources,
        timings.slowest,
        timings.state_loaded - timings.script_started,
        timings.panes,
        timings.panes_adopted - timings.state_loaded,
    );
}

/// Brings the window to the front. False when it does not exist.
#[tauri::command]
pub fn project_window_focus(app: AppHandle, window_id: String) -> bool {
    match app.get_webview_window(&label_for(&window_id)) {
        Some(window) => {
            focus(&window);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn project_window_close(app: AppHandle, window_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label_for(&window_id)) {
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
    windows.windows.lock().remove(label);
    windows.opened_at.lock().remove(label);
    let window_id = label[LABEL_PREFIX.len()..].to_string();
    let _ = app.emit_to("main", CLOSED_EVENT, ClosedPayload { window_id });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ids_stay_within_label_characters() {
        assert!(is_valid_window_id("5f1c-aa"));
        assert!(is_valid_window_id("5f1c-aa--0b2e-77"));
        assert!(!is_valid_window_id(""));
        assert!(!is_valid_window_id("../main"));
        assert!(!is_valid_window_id("a/b"));
        assert!(!is_valid_window_id("a b"));
    }

    #[test]
    fn labels_are_derived_from_the_project_id_and_recognised() {
        assert_eq!(label_for("abc-123"), "project-abc-123");
        assert!(is_project_window("project-abc-123"));
        assert!(!is_project_window("main"));
        assert!(!is_project_window("settings"));
    }
}
