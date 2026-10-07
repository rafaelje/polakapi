use super::*;

#[cfg(unix)]
#[test]
fn atomic_writes_do_not_follow_a_preexisting_temporary_symlink() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    let unrelated = home.path().join("unrelated.json");
    std::fs::write(&unrelated, "{\"keep\":true}").unwrap();
    let collision = path.with_extension("json.polakapi-tmp");
    std::os::unix::fs::symlink(&unrelated, &collision).unwrap();
    write_atomically(&path, "{\"updated\":true}\n").unwrap();
    assert_eq!(
        std::fs::read_to_string(&unrelated).unwrap(),
        "{\"keep\":true}"
    );
    assert_eq!(std::fs::read_link(&collision).unwrap(), unrelated);
    assert!(!std::fs::symlink_metadata(&path)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(read(&path), json!({"updated": true}));
}

#[test]
fn failed_atomic_replacement_leaves_no_temporary_file() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    std::fs::create_dir(&path).unwrap();
    assert!(write_atomically(&path, "{}\n").is_err());
    let entries: Vec<_> = std::fs::read_dir(home.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(entries, vec![path]);
}

#[cfg(unix)]
#[test]
fn atomic_writes_create_private_files_and_preserve_existing_modes() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    for format in [Format::Claude, Format::Cursor] {
        let path = home.path().join("settings.json");
        sync_file(&path, "/opt/polakapi", true, format).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        for mode in [0o400, 0o600, 0o640] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            sync_file(&path, "/different/polakapi", true, format).unwrap();
            sync_file(&path, "/opt/polakapi", true, format).unwrap();
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn concurrent_hook_syncs_publish_whole_json_without_temporary_files() {
    use std::sync::{Arc, Barrier};
    let home = tempfile::tempdir().unwrap();
    for format in [Format::Claude, Format::Cursor] {
        let path = home.path().join("settings.json");
        std::fs::write(&path, "{\"custom\":true}").unwrap();
        sync_file(&path, "/initial/polakapi", true, format).unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let writers: Vec<_> = (0..8)
            .map(|writer| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for iteration in 0..8 {
                        let bin =
                            format!("/writer-{writer}-{iteration}-{}/polakapi", "x".repeat(4096));
                        sync_file(&path, &bin, true, format)?;
                    }
                    Ok::<_, String>(())
                })
            })
            .collect();
        while writers.iter().any(|writer| !writer.is_finished()) {
            let root = read(&path);
            assert_eq!(root["custom"], true);
            let (pre, start) = match format {
                Format::Claude => (
                    &root["hooks"]["PreToolUse"][0]["hooks"][0],
                    &root["hooks"]["SessionStart"][0]["hooks"][0],
                ),
                Format::Cursor => (
                    &root["hooks"]["preToolUse"][0],
                    &root["hooks"]["sessionStart"][0],
                ),
            };
            assert_eq!(pre["command"], start["command"]);
        }
        for writer in writers {
            writer.join().unwrap().unwrap();
        }
        assert_eq!(read(&path)["custom"], true);
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 1);
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn atomic_replacement_retries_a_short_lived_windows_handle_conflict() {
    use std::os::windows::fs::OpenOptionsExt;
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    std::fs::write(&path, "{\"old\":true}").unwrap();
    let reader = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1) // FILE_SHARE_READ, intentionally no FILE_SHARE_DELETE.
        .open(&path)
        .unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(reader);
    });
    write_atomically(&path, "{\"new\":true}\n").unwrap();
    release.join().unwrap();
    assert_eq!(read(&path), json!({"new": true}));
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn persistent_windows_handle_conflict_returns_error_and_cleans_up() {
    use std::os::windows::fs::OpenOptionsExt;
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    std::fs::write(&path, "{\"old\":true}").unwrap();
    let _reader = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    assert!(write_atomically(&path, "{\"new\":true}\n").is_err());
    assert_eq!(read(&path), json!({"old": true}));
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 1);
}

#[test]
fn concurrent_identical_syncs_change_settings_only_once() {
    use std::sync::{Arc, Barrier};
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("settings.json");
    std::fs::write(&path, "{\"custom\":true}").unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let writers: Vec<_> = (0..8)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                sync(&path, "/opt/polakapi", true).unwrap()
            })
        })
        .collect();
    let changed = writers
        .into_iter()
        .filter_map(|writer| writer.join().unwrap().then_some(()))
        .count();
    assert_eq!(changed, 1);
    assert_eq!(read(&path)["custom"], true);
}

#[cfg(unix)]
#[test]
fn dangling_settings_symlinks_are_never_replaced() {
    for relative in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("settings.json");
        let target = if relative {
            PathBuf::from("missing.json")
        } else {
            home.path().join("missing.json")
        };
        std::os::unix::fs::symlink(&target, &path).unwrap();
        for format in [Format::Claude, Format::Cursor] {
            assert!(!sync_file(&path, "/opt/polakapi", false, format).unwrap());
            assert!(sync_file(&path, "/opt/polakapi", true, format).is_err());
            assert_eq!(std::fs::read_link(&path).unwrap(), target);
            assert!(!home.path().join("missing.json").exists());
        }
    }
}

#[cfg(unix)]
#[test]
fn unreadable_settings_are_preserved() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    for format in [Format::Claude, Format::Cursor] {
        for enabled in [true, false] {
            let path = home.path().join("settings.json");
            let original = b"{\"custom\":true}";
            std::fs::write(&path, original).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
            let result = sync_file(&path, "/opt/polakapi", enabled, format);
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(result.is_err(), "unreadable file must not be initialized");
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert_eq!(mode, 0);
        }
    }
}

fn settings(dir: &tempfile::TempDir) -> PathBuf {
    dir.path().join(".claude").join("settings.json")
}

#[cfg(unix)]
#[test]
fn a_symlinked_settings_file_is_written_through_its_link() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("dotfiles").join("settings.json");
    std::fs::create_dir_all(real.parent().unwrap()).unwrap();
    std::fs::write(&real, "{}").unwrap();
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = settings(&dir);
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();

    for target in [real.clone(), PathBuf::from("../dotfiles/settings.json")] {
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        for format in [Format::Claude, Format::Cursor] {
            std::fs::write(&real, "{\"custom\":true}").unwrap();
            assert!(sync_file(&link, "/opt/polakapi", true, format).unwrap());
            assert_eq!(std::fs::read_link(&link).unwrap(), target);
            assert_eq!(read(&real)["custom"], true);
            assert!(read(&real)["hooks"].is_object());
            let mode = std::fs::metadata(&real).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
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
fn collapses_copies_left_after_claude_stripped_the_marker() {
    // Observed on a real machine: Claude Code rewrote settings.json on a
    // `/model` change and dropped `_polakapi`; five starts later there
    // were five copies of each hook.
    let home = tempfile::tempdir().unwrap();
    let path = settings(&home);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let stripped = |event: &str| {
        json!({
            "matcher": if event == "PreToolUse" { "Bash" } else { "startup|resume" },
            "hooks": [{ "type": "command", "command": "'/old/polakapi' ctx-hook --for claude", "timeout": 10 }]
        })
    };
    std::fs::write(
        &path,
        serde_json::to_string(&json!({
            "hooks": {
                "PreToolUse": [
                    stripped("PreToolUse"), stripped("PreToolUse"), stripped("PreToolUse"),
                    { "hooks": [{ "type": "command", "command": "read -r input; echo mine" }] }
                ],
                "SessionStart": [stripped("SessionStart"), stripped("SessionStart")]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(sync(&path, "/new/polakapi", true).unwrap());
    let root = read(&path);
    let pre = root["hooks"]["PreToolUse"].as_array().unwrap();
    let ours: Vec<&Value> = pre
        .iter()
        .filter(|group| {
            group["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("ctx-hook")
        })
        .collect();
    assert_eq!(ours.len(), 1);
    assert_eq!(
        ours[0]["hooks"][0]["command"],
        "'/new/polakapi' ctx-hook --for claude"
    );
    // The user's own hook is not ours and stays.
    assert!(pre
        .iter()
        .any(|g| g["hooks"][0]["command"] == "read -r input; echo mine"));
    assert_eq!(root["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
    // Disabling removes them even without the marker.
    sync(&path, "/new/polakapi", false).unwrap();
    assert!(!read(&path).to_string().contains("ctx-hook"));
}

#[test]
fn only_polakapis_own_command_shape_counts_as_ours() {
    assert!(is_own_command("'/a/b/polakapi' ctx-hook --for claude"));
    assert!(is_own_command("\"/a/polakapi.exe\" ctx-hook --for cursor"));
    assert!(is_own_command("/a/polakapi ctx-hook"));
    assert!(!is_own_command("/a/other ctx-hook --for claude"));
    assert!(!is_own_command("polakapi ctx-hook --for codex"));
    assert!(!is_own_command("echo polakapi ctx-hook --for claude | tee"));
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
