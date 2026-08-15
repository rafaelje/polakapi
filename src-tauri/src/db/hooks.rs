use serde::Serialize;
use std::path::Path;

use crate::platform_command;

const POLAKAPI_HOOK_MARKER: &str = "polakapi-managed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallHooksResult {
    pub cli: String,
    pub ok: bool,
    pub message: String,
    pub already_installed: bool,
}

#[tauri::command]
pub fn prompt_install_hooks(cli: String) -> Result<InstallHooksResult, String> {
    install_hooks_for_cli(&cli)
}

pub fn install_hooks_for_cli(cli: &str) -> Result<InstallHooksResult, String> {
    let bin = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .to_string_lossy()
        .to_string();
    match cli.to_ascii_lowercase().as_str() {
        "claude" => install_hooks("claude", &bin),
        "codex" => install_hooks("codex", &bin),
        other => Err(format!("unsupported cli: {other}")),
    }
}

fn install_hooks(cli: &str, bin: &str) -> Result<InstallHooksResult, String> {
    let home = user_home_dir()?;
    install_hooks_at_home(cli, bin, &home)
}

fn install_hooks_at_home(cli: &str, bin: &str, home: &Path) -> Result<InstallHooksResult, String> {
    let (directory, file) = match cli {
        "claude" => (".claude", "settings.json"),
        "codex" => (".codex", "hooks.json"),
        _ => return Err(format!("unsupported cli: {cli}")),
    };
    let directory = home.join(directory);
    std::fs::create_dir_all(&directory)
        .map_err(|e| format!("mkdir {}: {e}", directory.display()))?;
    let path = directory.join(file);
    let mut root = read_settings(&path)?;
    let already_installed = has_marker(&root);

    if !already_installed {
        let desired = desired_hooks(bin);
        if let Some(hooks) = root.as_object_mut().and_then(|object| {
            object
                .entry("hooks")
                .or_insert(serde_json::json!({}))
                .as_object_mut()
        }) {
            merge_marker_groups(hooks, &desired);
        } else {
            root["hooks"] = desired;
        }
        let serialized = serde_json::to_string_pretty(&root)
            .map_err(|e| format!("serialize {}: {e}", path.display()))?;
        std::fs::write(&path, serialized).map_err(|e| format!("write {}: {e}", path.display()))?;
    }

    Ok(InstallHooksResult {
        cli: cli.to_string(),
        ok: true,
        message: format!(
            "{} hooks in {}",
            if already_installed {
                "kept"
            } else {
                "installed"
            },
            path.display()
        ),
        already_installed,
    })
}

fn user_home_dir() -> Result<std::path::PathBuf, String> {
    platform_command::user_home_dir()
        .ok_or_else(|| "user home directory is unavailable".to_string())
}

fn read_settings(path: &Path) -> Result<serde_json::Value, String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Ok(serde_json::json!({}));
    };
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn desired_hooks(bin: &str) -> serde_json::Value {
    let command = format!("\"{bin}\" capture");
    serde_json::json!({
        "SessionStart": [{
            "matcher": "startup|resume",
            "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }],
        "UserPromptSubmit": [{
            "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }],
        "Stop": [{
            "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }],
        "SessionEnd": [{
            "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }]
    })
}

fn has_marker(root: &serde_json::Value) -> bool {
    root.get("hooks")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flat_map(|hooks| hooks.values())
        .filter_map(serde_json::Value::as_array)
        .flatten()
        .filter_map(|group| group.get("hooks"))
        .filter_map(serde_json::Value::as_array)
        .flatten()
        .any(is_marker)
}

fn merge_marker_groups(
    hooks: &mut serde_json::Map<String, serde_json::Value>,
    desired: &serde_json::Value,
) {
    let Some(desired) = desired.as_object() else {
        return;
    };
    for (event, groups) in desired {
        let desired_groups = groups.as_array().cloned().unwrap_or_default();
        if let Some(existing) = hooks
            .get_mut(event)
            .and_then(serde_json::Value::as_array_mut)
        {
            existing.retain(|group| {
                group
                    .get("hooks")
                    .and_then(serde_json::Value::as_array)
                    .map(|handlers| !handlers.iter().all(is_marker))
                    .unwrap_or(true)
            });
            existing.extend(desired_groups);
        } else {
            hooks.insert(event.clone(), serde_json::Value::Array(desired_groups));
        }
    }
}

fn is_marker(hook: &serde_json::Value) -> bool {
    hook.get("_polakapi").and_then(serde_json::Value::as_str) == Some(POLAKAPI_HOOK_MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_and_replaces_managed_hooks_without_removing_user_hooks() {
        let mut root = serde_json::json!({
            "hooks": {
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "user-command" }] },
                    { "hooks": [{ "type": "command", "command": "old", "_polakapi": POLAKAPI_HOOK_MARKER }] }
                ]
            }
        });
        assert!(has_marker(&root));

        let desired = desired_hooks("/tmp/polakapi");
        let hooks = root["hooks"].as_object_mut().unwrap();
        merge_marker_groups(hooks, &desired);

        let stop = root["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "user-command");
        assert_eq!(stop[1]["hooks"][0]["_polakapi"], POLAKAPI_HOOK_MARKER);
    }

    #[test]
    fn installs_hooks_under_the_supplied_home_directory() {
        let home = tempfile::tempdir().unwrap();
        let result =
            install_hooks_at_home("claude", r"C:\Program Files\polakapi.exe", home.path()).unwrap();

        assert!(result.ok);
        let settings = home.path().join(".claude").join("settings.json");
        assert!(settings.is_file());
        let root = read_settings(&settings).unwrap();
        assert!(has_marker(&root));
    }
}
