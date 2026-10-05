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
        Ok(_) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("could not read {}: {error}", path.display())),
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

/// Ours by marker, or by the exact command shape only polakapi writes.
///
/// The marker is not enough on its own: Claude Code re-serialises
/// settings.json through its own schema when it saves (a `/model` change is
/// enough) and drops keys it does not know, including the marker. Every start
/// then appended another copy of each hook instead of replacing it.
fn is_managed(handler: &Value) -> bool {
    handler.get(MARKER_KEY).and_then(Value::as_str) == Some(MARKER)
        || handler
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(is_own_command)
}

fn is_own_command(command: &str) -> bool {
    let Some((binary, rest)) = command.trim().rsplit_once(" ctx-hook") else {
        return false;
    };
    let target_ok = matches!(rest.trim(), "" | "--for claude" | "--for cursor");
    let binary = binary.trim().trim_matches(['\'', '"']);
    target_ok
        && !binary.contains(char::is_whitespace)
        && std::path::Path::new(binary)
            .file_stem()
            .is_some_and(|stem| stem == "polakapi")
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
/// with a truncated settings file. A symlinked settings file (dotfiles setups)
/// is written through to its target, keeping the link and the target's mode.
fn write_atomically(path: &Path, text: &str) -> Result<(), String> {
    let target = match std::fs::canonicalize(path) {
        Ok(target) => target,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::symlink_metadata(path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(format!(
                        "could not resolve symlink {}: {error}",
                        path.display()
                    ));
                }
                Ok(_) => path.to_path_buf(),
                Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => {
                    path.to_path_buf()
                }
                Err(error) => return Err(format!("could not inspect {}: {error}", path.display())),
            }
        }
        Err(error) => return Err(format!("could not resolve {}: {error}", path.display())),
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let permissions = match std::fs::metadata(&target) {
        Ok(meta) => Some(meta.permissions()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("could not inspect {}: {error}", target.display())),
    };
    let mut builder = tempfile::Builder::new();
    builder.prefix(".polakapi-settings-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o600));
    }
    let mut temp = builder
        .tempfile_in(target.parent().unwrap_or_else(|| Path::new(".")))
        .map_err(|e| {
            format!(
                "could not create temporary file for {}: {e}",
                target.display()
            )
        })?;
    // Each writer owns its file; restrictive creation precedes all settings data.
    // NamedTempFile also removes the file on write, permission, or persist errors.
    std::io::Write::write_all(&mut temp, text.as_bytes())
        .map_err(|e| format!("could not write {}: {e}", temp.path().display()))?;
    if let Some(permissions) = permissions {
        temp.as_file().set_permissions(permissions).map_err(|e| {
            format!(
                "could not preserve permissions for {}: {e}",
                target.display()
            )
        })?;
    }
    temp.persist(&target)
        .map(|_| ())
        .map_err(|e| format!("could not replace {}: {e}", target.display()))
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
