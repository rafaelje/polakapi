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

/// Rewrites the capture hooks for each CLI that already has them, so an older
/// install picks up changes such as recording sessions started by `/clear`,
/// and hooks left by another polakapi binary collapse into one set. CLIs the
/// user never enabled are left alone.
pub fn refresh_installed_hooks() -> Result<(), String> {
    let bin = std::env::current_exe()
        .map_err(|e| format!("resolve current exe: {e}"))?
        .to_string_lossy()
        .to_string();
    let home = user_home_dir()?;
    refresh_installed_hooks_at_home(&bin, &home)
}

fn refresh_installed_hooks_at_home(bin: &str, home: &Path) -> Result<(), String> {
    for (cli, file) in [
        ("claude", home.join(".claude").join("settings.json")),
        ("codex", home.join(".codex").join("hooks.json")),
    ] {
        if file.is_file() && has_marker(&read_settings(&file)?) {
            install_hooks_at_home(cli, bin, home)?;
        }
    }
    Ok(())
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

    {
        let mut desired = desired_hooks(bin);
        if cli != "claude" {
            for event in [
                "Notification",
                "SubagentStart",
                "SubagentStop",
                "PostToolUse",
            ] {
                desired.as_object_mut().unwrap().remove(event);
            }
        }
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
                "updated"
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
            "matcher": "startup|resume|clear",
            "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }],
        "UserPromptSubmit": [{
            "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }],
        "Stop": [{
            "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }]
        }],
        "SubagentStart": [{ "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }] }],
        "SubagentStop": [{ "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }] }],
        "PostToolUse": [{ "hooks": [{ "type": "command", "command": command, "_polakapi": POLAKAPI_HOOK_MARKER }] }],
        "Notification": [{
            "matcher": "permission_prompt|idle_prompt",
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
        || is_legacy_capture(hook)
}

/// Capture hooks written before the marker existed carry no `_polakapi` key,
/// so they are recognised by the exact command shape only polakapi writes:
/// `"<path ending in polakapi>" capture`. Without this they could never be
/// upgraded or deduplicated.
fn is_legacy_capture(hook: &serde_json::Value) -> bool {
    hook.get("_polakapi").is_none()
        && hook
            .get("command")
            .and_then(serde_json::Value::as_str)
            .and_then(|command| command.strip_suffix("\" capture"))
            .is_some_and(|quoted| {
                let binary = quoted.trim_start_matches('"');
                quoted.starts_with('"')
                    && std::path::Path::new(binary)
                        .file_stem()
                        .is_some_and(|stem| stem == "polakapi")
            })
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
    fn upgrades_managed_hooks_without_duplicating_or_removing_user_hooks() {
        let home = tempfile::tempdir().unwrap();
        install_hooks_at_home("claude", "/old/polakapi", home.path()).unwrap();
        let path = home.path().join(".claude/settings.json");
        let mut root = read_settings(&path).unwrap();
        root["hooks"]
            .as_object_mut()
            .unwrap()
            .remove("Notification");
        root["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"hooks":[{"type":"command","command":"user-command"}]}));
        std::fs::write(&path, serde_json::to_vec(&root).unwrap()).unwrap();
        install_hooks_at_home("claude", "/new/polakapi", home.path()).unwrap();
        install_hooks_at_home("claude", "/new/polakapi", home.path()).unwrap();
        let root = read_settings(&path).unwrap();
        assert_eq!(root["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(root["hooks"]["Notification"].as_array().unwrap().len(), 1);
        assert_eq!(
            root["hooks"]["Stop"][0]["hooks"][0]["command"],
            "user-command"
        );
        assert_eq!(
            root["hooks"]["Stop"][1]["hooks"][0]["command"],
            "\"/new/polakapi\" capture"
        );
    }

    #[test]
    fn refreshing_upgrades_existing_installs_and_collapses_duplicates() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude/settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // What an older install left behind: two binaries, no `clear` matcher.
        let old_group = |bin: &str| {
            serde_json::json!({
                "matcher": "startup|resume",
                "hooks": [{ "type": "command", "command": format!("\"{bin}\" capture"), "_polakapi": POLAKAPI_HOOK_MARKER }]
            })
        };
        std::fs::write(
            &path,
            serde_json::to_string(&serde_json::json!({
                "hooks": { "SessionStart": [old_group("/debug/polakapi"), old_group("/release/polakapi")] }
            }))
            .unwrap(),
        )
        .unwrap();

        refresh_installed_hooks_at_home("/new/polakapi", home.path()).unwrap();

        let root = read_settings(&path).unwrap();
        let start = root["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(start.len(), 1);
        assert_eq!(start[0]["matcher"], "startup|resume|clear");
        assert_eq!(start[0]["hooks"][0]["command"], "\"/new/polakapi\" capture");
    }

    #[test]
    fn refreshing_adopts_capture_hooks_written_before_the_marker_existed() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude/settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let legacy = |bin: &str| {
            serde_json::json!({
                "matcher": "startup|resume",
                "hooks": [{ "type": "command", "command": format!("\"{bin}\" capture") }]
            })
        };
        std::fs::write(
            &path,
            serde_json::to_string(&serde_json::json!({
                "hooks": {
                    "SessionStart": [
                        legacy("/repo/target/debug/polakapi"),
                        legacy("/repo/target/release/polakapi"),
                        { "hooks": [{ "type": "command", "command": "\"/usr/bin/other\" capture" }] },
                        { "hooks": [{ "type": "command", "command": "polakapi capture --mine" }] }
                    ]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        refresh_installed_hooks_at_home("/new/polakapi", home.path()).unwrap();

        let root = read_settings(&path).unwrap();
        let commands: Vec<String> = root["hooks"]["SessionStart"]
            .as_array()
            .unwrap()
            .iter()
            .map(|group| group["hooks"][0]["command"].as_str().unwrap().to_string())
            .collect();
        // Look-alikes that are not polakapi's exact shape are kept.
        assert!(commands.contains(&"\"/usr/bin/other\" capture".to_string()));
        assert!(commands.contains(&"polakapi capture --mine".to_string()));
        // The two legacy copies collapse into one current, marked hook.
        let ours: Vec<&String> = commands
            .iter()
            .filter(|c| c.contains("/new/polakapi"))
            .collect();
        assert_eq!(ours.len(), 1);
        assert!(!commands.iter().any(|c| c.contains("/repo/target/")));
        let start = root["hooks"]["SessionStart"].as_array().unwrap();
        let group = start
            .iter()
            .find(|g| g["hooks"][0]["command"] == "\"/new/polakapi\" capture")
            .unwrap();
        assert_eq!(group["matcher"], "startup|resume|clear");
    }

    #[test]
    fn refreshing_never_installs_hooks_the_user_did_not_enable() {
        let home = tempfile::tempdir().unwrap();
        refresh_installed_hooks_at_home("/new/polakapi", home.path()).unwrap();
        assert!(!home.path().join(".claude/settings.json").exists());
        assert!(!home.path().join(".codex/hooks.json").exists());
    }

    #[test]
    fn codex_keeps_only_supported_lifecycle_hooks() {
        let home = tempfile::tempdir().unwrap();
        install_hooks_at_home("codex", "/tmp/polakapi", home.path()).unwrap();
        let root = read_settings(&home.path().join(".codex/hooks.json")).unwrap();
        assert!(root["hooks"].get("Notification").is_none());
        assert!(root["hooks"].get("SubagentStart").is_none());
        assert!(root["hooks"].get("Stop").is_some());
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
