use std::collections::HashMap;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::blocking;
use crate::git_review::validate_repo_path;
use crate::project_watch::ProjectWatcher;

const CHANGED_EVENT: &str = "code-review:changed";

#[derive(Default)]
pub struct CodeReviewWatchers(Mutex<HashMap<String, ProjectWatcher>>);

impl CodeReviewWatchers {
    pub fn stop(&self, label: &str) {
        let _stopped = self.0.lock().remove(label);
    }

    fn replace(&self, label: String, watcher: ProjectWatcher) {
        let _previous = self.0.lock().insert(label, watcher);
    }
}

#[tauri::command]
pub async fn code_review_watch_start(
    window: WebviewWindow,
    project_path: String,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    blocking(move || start_sync(app, label, &project_path)).await
}

fn start_sync(app: AppHandle, label: String, project_path: &str) -> Result<(), String> {
    let project = validate_repo_path(project_path)?;
    let watchers = app.state::<CodeReviewWatchers>();
    watchers.stop(&label);
    let emitter = app.clone();
    let target = label.clone();
    let watcher = ProjectWatcher::start(&project, move || {
        let _ = emitter.emit_to(target.as_str(), CHANGED_EVENT, ());
    })
    .map_err(|error| format!("could not watch {project_path}: {error}"))?;
    watchers.replace(label.clone(), watcher);
    if app.get_webview_window(&label).is_none() {
        watchers.stop(&label);
    }
    Ok(())
}
