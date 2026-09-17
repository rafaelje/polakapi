use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::ctx::config::{self, CtxConfig};

// Installs and removes the context mode hooks in Claude Code's user settings so
// they follow the Settings toggles.
//
// The hooks carry their own marker, separate from the capture hooks', so syncing
// context mode never touches the notification hooks or anything the user wrote.
// Only Claude Code is wired: its hook format was verified end to end, including
// that a rewrite without `permissionDecision` keeps the user's approval flow.

const MARKER_KEY: &str = "_polakapi";
const MARKER: &str = "polakapi-context-mode";
const HOOK_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// True when the hooks are now present for Claude Code.
    pub claude_hooks: bool,
    /// False when the file already matched and nothing was written.
    pub changed: bool,
    pub settings_path: String,
}

#[tauri::command]
pub fn ctx_sync_hooks(app: tauri::AppHandle) -> Result<SyncResult, String> {
    let config = config::config_path_for_app(&app)
        .map(|path| config::parse(&config::read_raw(&path)))
        .unwrap_or_default();
    sync_for_current_binary(&config)
}

pub fn sync_for_current_binary(config: &CtxConfig) -> Result<SyncResult, String> {
    let bin = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .to_string_lossy()
        .into_owned();
    let home = crate::platform_command::user_home_dir()
        .ok_or_else(|| "user home directory is unavailable".to_string())?;
    sync(
        &claude_settings_path(&home),
        &bin,
        config.enabled_for("claude"),
    )
}

fn claude_settings_path(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}

pub fn sync(path: &Path, bin: &str, enabled: bool) -> Result<SyncResult, String> {
    let original = match std::fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => Some(text),
        _ => None,
    };
    let mut root: Value = match &original {
        Some(text) => serde_json::from_str(text)
            // Refuse to rewrite a file we cannot parse rather than lose its contents.
            .map_err(|e| format!("could not parse {}: {e}", path.display()))?,
        None => json!({}),
    };
    let result = |changed| SyncResult {
        claude_hooks: enabled,
        changed,
        settings_path: path.display().to_string(),
    };

    let before = root.clone();
    apply(&mut root, bin, enabled)?;
    if root == before && (original.is_some() || !enabled) {
        return Ok(result(false));
    }

    let text = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("serialize {}: {e}", path.display()))?;
    write_atomically(path, &format!("{text}\n"))?;
    Ok(result(true))
}

/// Removes every context mode hook group, then adds the current ones back when
/// enabled. Rebuilding rather than patching keeps a moved binary from leaving a
/// stale command behind.
fn apply(root: &mut Value, bin: &str, enabled: bool) -> Result<(), String> {
    let object = root
        .as_object_mut()
        .ok_or_else(|| "settings root is not a JSON object".to_string())?;
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "settings \"hooks\" is not a JSON object".to_string())?;

    remove_managed(hooks);
    if enabled {
        let command = format!("{} ctx-hook", crate::ctx::intercept::shell_quote(bin));
        add_group(hooks, "PreToolUse", Some("Bash"), &command);
        add_group(
            hooks,
            "SessionStart",
            Some("startup|resume|clear|compact"),
            &command,
        );
    }
    if hooks.is_empty() {
        object.remove("hooks");
    }
    Ok(())
}

fn is_managed(handler: &Value) -> bool {
    handler.get(MARKER_KEY).and_then(Value::as_str) == Some(MARKER)
}

fn remove_managed(hooks: &mut Map<String, Value>) {
    for groups in hooks.values_mut() {
        let Some(list) = groups.as_array_mut() else {
            continue;
        };
        for group in list.iter_mut() {
            if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                handlers.retain(|handler| !is_managed(handler));
            }
        }
        // Drop groups we emptied; leave any group the user left empty on purpose.
        list.retain(|group| {
            group
                .get("hooks")
                .and_then(Value::as_array)
                .is_none_or(|handlers| !handlers.is_empty())
        });
    }
    hooks.retain(|_, groups| groups.as_array().is_none_or(|list| !list.is_empty()));
}

fn add_group(hooks: &mut Map<String, Value>, event: &str, matcher: Option<&str>, command: &str) {
    let mut group = json!({
        "hooks": [{
            "type": "command",
            "command": command,
            "timeout": HOOK_TIMEOUT_SECS,
            MARKER_KEY: MARKER,
        }]
    });
    if let Some(matcher) = matcher {
        group["matcher"] = Value::String(matcher.to_string());
    }
    let list = hooks.entry(event).or_insert_with(|| json!([]));
    if let Some(list) = list.as_array_mut() {
        list.push(group);
    }
}

/// Writes through a sibling temp file so a crash mid-write never leaves Claude
/// with a truncated settings file.
fn write_atomically(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let temp = path.with_extension("json.polakapi-tmp");
    std::fs::write(&temp, text).map_err(|e| format!("could not write {}: {e}", temp.display()))?;
    std::fs::rename(&temp, path).map_err(|e| format!("could not replace {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join(".claude").join("settings.json")
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn enabling_installs_pre_tool_use_and_session_start_only() {
        let home = tempfile::tempdir().unwrap();
        let path = settings(&home);
        sync(&path, "/opt/polakapi", true).unwrap();

        let root = read(&path);
        let pre = &root["hooks"]["PreToolUse"][0];
        assert_eq!(pre["matcher"], "Bash");
        assert_eq!(pre["hooks"][0]["command"], "'/opt/polakapi' ctx-hook");
        assert_eq!(pre["hooks"][0][MARKER_KEY], MARKER);
        assert!(root["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with("ctx-hook"));
        // Too late to replace output, so it is never installed.
        assert!(root["hooks"].get("PostToolUse").is_none());
    }

    #[test]
    fn disabling_removes_only_what_context_mode_added() {
        let home = tempfile::tempdir().unwrap();
        let path = settings(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "model": "opus",
                "hooks": {
                    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "user-guard" }] }],
                    "Stop": [{ "hooks": [{ "type": "command", "command": "capture", "_polakapi": "polakapi-managed" }] }]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        sync(&path, "/opt/polakapi", true).unwrap();
        assert_eq!(
            read(&path)["hooks"]["PreToolUse"].as_array().unwrap().len(),
            2
        );

        sync(&path, "/opt/polakapi", false).unwrap();
        let root = read(&path);
        assert_eq!(root["model"], "opus");
        let pre = root["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 1);
        assert_eq!(pre[0]["hooks"][0]["command"], "user-guard");
        // The notification capture hook is a different feature and stays.
        assert_eq!(root["hooks"]["Stop"][0]["hooks"][0]["command"], "capture");
        assert!(root["hooks"].get("SessionStart").is_none());
    }

    #[test]
    fn syncing_twice_does_not_duplicate_and_does_not_rewrite() {
        let home = tempfile::tempdir().unwrap();
        let path = settings(&home);
        assert!(sync(&path, "/opt/polakapi", true).unwrap().changed);
        assert!(!sync(&path, "/opt/polakapi", true).unwrap().changed);
        assert_eq!(
            read(&path)["hooks"]["PreToolUse"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn a_moved_binary_replaces_the_old_command() {
        let home = tempfile::tempdir().unwrap();
        let path = settings(&home);
        sync(&path, "/old/polakapi", true).unwrap();
        sync(&path, "/new/polakapi", true).unwrap();
        let pre = read(&path)["hooks"]["PreToolUse"].clone();
        assert_eq!(pre.as_array().unwrap().len(), 1);
        assert_eq!(pre[0]["hooks"][0]["command"], "'/new/polakapi' ctx-hook");
    }

    #[test]
    fn disabling_when_nothing_was_installed_creates_no_file() {
        let home = tempfile::tempdir().unwrap();
        let path = settings(&home);
        assert!(!sync(&path, "/opt/polakapi", false).unwrap().changed);
        assert!(!path.exists());
    }

    #[test]
    fn refuses_to_touch_a_file_it_cannot_parse() {
        let home = tempfile::tempdir().unwrap();
        let path = settings(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ // a comment\n}").unwrap();
        assert!(sync(&path, "/opt/polakapi", true).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ // a comment\n}");
    }

    #[test]
    fn keeps_a_user_group_that_shares_the_event_with_ours() {
        let home = tempfile::tempdir().unwrap();
        let path = settings(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "hooks": { "SessionStart": [{ "matcher": "startup", "hooks": [{ "type": "command", "command": "mine" }] }] }
            }))
            .unwrap(),
        )
        .unwrap();
        sync(&path, "/opt/polakapi", true).unwrap();
        sync(&path, "/opt/polakapi", false).unwrap();
        let start = read(&path)["hooks"]["SessionStart"].clone();
        assert_eq!(start.as_array().unwrap().len(), 1);
        assert_eq!(start[0]["hooks"][0]["command"], "mine");
    }
}
