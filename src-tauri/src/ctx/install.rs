use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::ctx::config::{self, CtxConfig};

// Installs and removes the context mode hooks so they follow the Settings
// toggles: Claude Code in ~/.claude/settings.json, the Cursor CLI in
// ~/.cursor/hooks.json. Both formats were verified against real sessions,
// including that a rewrite without a permission decision is honoured.
//
// The two files differ in shape. Claude nests handlers inside matcher groups;
// Cursor lists flat entries under a versioned root. Each hook passes `--for`, so
// the Claude hook stays quiet when the Cursor CLI reads Claude's file too.
//
// Hooks carry their own marker, separate from the capture hooks', so syncing
// never touches the notification hooks or anything the user wrote.

const MARKER_KEY: &str = "_polakapi";
const MARKER: &str = "polakapi-context-mode";
const HOOK_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// True when the hooks are now present for Claude Code.
    pub claude_hooks: bool,
    /// True when the hooks are now present for the Cursor CLI.
    pub cursor_hooks: bool,
    /// False when every file already matched and nothing was written.
    pub changed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    /// `{"hooks": {"Event": [{"matcher", "hooks": [handler]}]}}`
    Claude,
    /// `{"version": 1, "hooks": {"event": [handler]}}`
    Cursor,
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
    sync_home(&home, &bin, config)
}

pub fn sync_home(home: &Path, bin: &str, config: &CtxConfig) -> Result<SyncResult, String> {
    let claude = config.enabled_for("claude");
    let cursor = config.enabled_for("cursor");
    let claude_changed = sync(&claude_settings_path(home), bin, claude)?;
    let cursor_changed = sync_cursor(&cursor_hooks_path(home), bin, cursor)?;
    Ok(SyncResult {
        claude_hooks: claude,
        cursor_hooks: cursor,
        changed: claude_changed || cursor_changed,
    })
}

fn claude_settings_path(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}

fn cursor_hooks_path(home: &Path) -> PathBuf {
    home.join(".cursor").join("hooks.json")
}

/// Claude Code. Returns whether the file was written.
pub fn sync(path: &Path, bin: &str, enabled: bool) -> Result<bool, String> {
    sync_file(path, bin, enabled, Format::Claude)
}

/// Cursor CLI. Returns whether the file was written.
pub fn sync_cursor(path: &Path, bin: &str, enabled: bool) -> Result<bool, String> {
    sync_file(path, bin, enabled, Format::Cursor)
}

fn sync_file(path: &Path, bin: &str, enabled: bool, format: Format) -> Result<bool, String> {
    let original = match std::fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => Some(text),
        _ => None,
    };
    // Nothing to remove from a file that does not exist, and nothing to add.
    if original.is_none() && !enabled {
        return Ok(false);
    }
    let mut root: Value = match &original {
        Some(text) => serde_json::from_str(text)
            // Refuse to rewrite a file we cannot parse rather than lose its contents.
            .map_err(|e| format!("could not parse {}: {e}", path.display()))?,
        None => json!({}),
    };
    let before = root.clone();
    match format {
        Format::Claude => apply(&mut root, bin, enabled)?,
        Format::Cursor => apply_cursor(&mut root, bin, enabled)?,
    }
    if root == before && (original.is_some() || !enabled) {
        return Ok(false);
    }

    let text = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("serialize {}: {e}", path.display()))?;
    write_atomically(path, &format!("{text}\n"))?;
    Ok(true)
}

fn hook_command(bin: &str, target: &str) -> String {
    format!(
        "{} ctx-hook --for {target}",
        crate::ctx::intercept::shell_quote(bin)
    )
}

/// Cursor: flat handlers. Removes ours, then adds the current ones when enabled.
fn apply_cursor(root: &mut Value, bin: &str, enabled: bool) -> Result<(), String> {
    let object = root
        .as_object_mut()
        .ok_or_else(|| "hooks file root is not a JSON object".to_string())?;
    let had_version = object.contains_key("version");
    let had_hooks = object.contains_key("hooks");
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "hooks file \"hooks\" is not a JSON object".to_string())?;

    for handlers in hooks.values_mut() {
        if let Some(list) = handlers.as_array_mut() {
            list.retain(|handler| !is_managed(handler));
        }
    }
    hooks.retain(|_, handlers| handlers.as_array().is_none_or(|list| !list.is_empty()));

    if enabled {
        let command = hook_command(bin, "cursor");
        let entry = |matcher: Option<&str>| {
            let mut handler = json!({
                "command": command,
                "timeout": HOOK_TIMEOUT_SECS,
                MARKER_KEY: MARKER,
            });
            if let Some(matcher) = matcher {
                handler["matcher"] = Value::String(matcher.to_string());
            }
            handler
        };
        for (event, matcher) in [("preToolUse", Some("Shell")), ("sessionStart", None)] {
            if let Some(list) = hooks
                .entry(event)
                .or_insert_with(|| json!([]))
                .as_array_mut()
            {
                list.push(entry(matcher));
            }
        }
    }
    let now_empty = hooks.is_empty();
    // Do not leave behind a "hooks" key this sync introduced for nothing.
    if now_empty && !had_hooks {
        object.remove("hooks");
    }
    // Cursor requires a version; add it only when the file needs one.
    if !had_version && !now_empty {
        object.insert("version".to_string(), json!(1));
    }
    Ok(())
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
        let command = hook_command(bin, "claude");
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
        assert_eq!(
            pre["hooks"][0]["command"],
            "'/opt/polakapi' ctx-hook --for claude"
        );
        assert_eq!(pre["hooks"][0][MARKER_KEY], MARKER);
        assert!(root["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with("ctx-hook --for claude"));
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
        assert!(sync(&path, "/opt/polakapi", true).unwrap());
        assert!(!sync(&path, "/opt/polakapi", true).unwrap());
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
        assert_eq!(
            pre[0]["hooks"][0]["command"],
            "'/new/polakapi' ctx-hook --for claude"
        );
    }

    #[test]
    fn disabling_when_nothing_was_installed_creates_no_file() {
        let home = tempfile::tempdir().unwrap();
        let path = settings(&home);
        assert!(!sync(&path, "/opt/polakapi", false).unwrap());
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

    fn cursor_file(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join(".cursor").join("hooks.json")
    }

    #[test]
    fn cursor_gets_flat_versioned_entries() {
        let home = tempfile::tempdir().unwrap();
        let path = cursor_file(&home);
        assert!(sync_cursor(&path, "/opt/polakapi", true).unwrap());

        let root = read(&path);
        assert_eq!(root["version"], 1);
        let pre = &root["hooks"]["preToolUse"][0];
        assert_eq!(pre["command"], "'/opt/polakapi' ctx-hook --for cursor");
        assert_eq!(pre["matcher"], "Shell");
        assert_eq!(pre[MARKER_KEY], MARKER);
        assert_eq!(
            root["hooks"]["sessionStart"][0]["command"],
            "'/opt/polakapi' ctx-hook --for cursor"
        );
        assert!(root["hooks"]["sessionStart"][0].get("matcher").is_none());
    }

    #[test]
    fn a_disabled_cli_never_creates_its_hooks_file() {
        // Found on a real start: Cursor off still produced {"hooks": {}}, a file
        // the user never had and one without the version Cursor requires.
        let home = tempfile::tempdir().unwrap();
        let config = CtxConfig {
            enabled: true,
            clis: vec!["claude".to_string()],
            ..CtxConfig::default()
        };
        sync_home(home.path(), "/opt/polakapi", &config).unwrap();
        assert!(settings(&home).exists());
        assert!(!cursor_file(&home).exists());
        assert!(!sync_cursor(&cursor_file(&home), "/opt/polakapi", false).unwrap());
        assert!(!cursor_file(&home).exists());
    }

    #[test]
    fn cursor_disable_keeps_the_users_own_hooks_and_version() {
        let home = tempfile::tempdir().unwrap();
        let path = cursor_file(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "version": 1,
                "hooks": { "preToolUse": [{ "command": "./guard.sh", "matcher": "Shell" }] }
            }))
            .unwrap(),
        )
        .unwrap();

        sync_cursor(&path, "/opt/polakapi", true).unwrap();
        assert_eq!(
            read(&path)["hooks"]["preToolUse"].as_array().unwrap().len(),
            2
        );

        sync_cursor(&path, "/opt/polakapi", false).unwrap();
        let root = read(&path);
        assert_eq!(root["version"], 1);
        let pre = root["hooks"]["preToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 1);
        assert_eq!(pre[0]["command"], "./guard.sh");
        assert!(root["hooks"].get("sessionStart").is_none());
    }

    #[test]
    fn cursor_sync_is_idempotent_and_follows_a_moved_binary() {
        let home = tempfile::tempdir().unwrap();
        let path = cursor_file(&home);
        assert!(sync_cursor(&path, "/old/polakapi", true).unwrap());
        assert!(!sync_cursor(&path, "/old/polakapi", true).unwrap());
        sync_cursor(&path, "/new/polakapi", true).unwrap();
        let pre = read(&path)["hooks"]["preToolUse"].clone();
        assert_eq!(pre.as_array().unwrap().len(), 1);
        assert_eq!(pre[0]["command"], "'/new/polakapi' ctx-hook --for cursor");
    }

    #[test]
    fn each_toggle_controls_only_its_own_file() {
        let home = tempfile::tempdir().unwrap();
        let config = CtxConfig {
            enabled: true,
            clis: vec!["cursor".to_string()],
            ..CtxConfig::default()
        };
        let result = sync_home(home.path(), "/opt/polakapi", &config).unwrap();
        assert!(result.cursor_hooks);
        assert!(!result.claude_hooks);
        assert!(cursor_file(&home).exists());
        // Claude was off and had no file, so none is created.
        assert!(!settings(&home).exists());
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
