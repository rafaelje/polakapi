use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pty_id: String,
    kind: String,
    cli: String,
}

fn connection(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS notification_events (id INTEGER PRIMARY KEY AUTOINCREMENT, pty_id TEXT NOT NULL, kind TEXT NOT NULL, cli TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));").map_err(|e| e.to_string())?;
    Ok(conn)
}

fn hook_kind(value: &Value) -> Option<&'static str> {
    match value.get("hook_event_name")?.as_str()? {
        "UserPromptSubmit" | "PostToolUse" | "SubagentStart" => Some("started"),
        "Stop" => Some("finished"),
        "SessionEnd" | "SubagentStop" => Some("ended"),
        "Notification" => match value.get("notification_type")?.as_str()? {
            "permission_prompt" => Some("permission"),
            "idle_prompt" => Some("waiting"),
            _ => None,
        },
        _ => None,
    }
}

fn hook_scope(pty_id: &str, value: &Value) -> Option<String> {
    if let Some(agent_id) = value.get("agent_id").and_then(Value::as_str) {
        Some(format!("{pty_id}:subagent:{agent_id}"))
    } else if matches!(
        value.get("hook_event_name").and_then(Value::as_str),
        Some("SubagentStart" | "SubagentStop")
    ) {
        None
    } else {
        Some(pty_id.to_string())
    }
}

pub fn capture_hook(path: &Path, value: &Value) -> Result<(), String> {
    let Some(kind) = hook_kind(value) else {
        return Ok(());
    };
    let Ok(pty_id) = std::env::var("POLAKAPI_PTY_ID") else {
        return Ok(());
    };
    if pty_id.is_empty() {
        return Ok(());
    }
    let Some(pty_id) = hook_scope(&pty_id, value) else {
        return Ok(());
    };
    let cli = std::env::var("POLAKAPI_CLI").unwrap_or_else(|_| "Agent".into());
    let conn = connection(path)?;
    conn.execute(
        "INSERT INTO notification_events (pty_id, kind, cli) VALUES (?1, ?2, ?3)",
        params![pty_id, kind, cli],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM notification_events WHERE id <= (SELECT MAX(id) - 500 FROM notification_events)", []).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn notification_events(app: AppHandle) -> Result<Vec<AgentEvent>, String> {
    let mut conn = connection(&crate::db::Db::resolve_path(&app)?)?;
    take_events(&mut conn)
}

fn take_events(conn: &mut Connection) -> Result<Vec<AgentEvent>, String> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let events = {
        let mut stmt = tx.prepare("SELECT pty_id, kind, cli FROM notification_events WHERE created_at >= unixepoch() - 30 ORDER BY id").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AgentEvent {
                    pty_id: row.get(0)?,
                    kind: row.get(1)?,
                    cli: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    tx.execute("DELETE FROM notification_events", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(events)
}

#[derive(Serialize)]
pub struct SystemSound {
    name: String,
    path: String,
}

#[tauri::command]
pub fn notification_sounds() -> Vec<SystemSound> {
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        roots.extend([
            PathBuf::from("/System/Library/Sounds"),
            PathBuf::from("/Library/Sounds"),
        ]);
        if let Some(home) = crate::platform_command::user_home_dir() {
            roots.push(home.join("Library/Sounds"));
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(windir) = std::env::var_os("WINDIR") {
        roots.push(PathBuf::from(windir).join("Media"));
    }
    #[cfg(target_os = "linux")]
    roots.extend([
        PathBuf::from("/usr/share/sounds/freedesktop/stereo"),
        PathBuf::from("/usr/share/sounds/gnome/default/alerts"),
    ]);
    let mut sounds = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && is_audio(&path) {
                sounds.push(SystemSound {
                    name: path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    path: path.to_string_lossy().into_owned(),
                });
            }
        }
    }
    sounds.sort_by(|a, b| a.name.cmp(&b.name));
    sounds
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "aiff" | "aif" | "wav" | "mp3" | "ogg" | "oga" | "m4a" | "caf"
            )
        })
}

#[tauri::command]
pub async fn notification_play_sound(path: String) -> Result<(), String> {
    let file = Path::new(&path);
    if !file.is_absolute() || !file.is_file() || !is_audio(file) {
        return Err("Choose an existing audio file".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = crate::platform_command::tokio_command("/usr/bin/afplay")?;
        c.arg(&path);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = crate::platform_command::tokio_command("paplay")?;
        c.arg(&path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = crate::platform_command::tokio_command("powershell.exe")?;
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(New-Object System.Media.SoundPlayer $env:POLAKAPI_SOUND_PATH).PlaySync()",
        ])
        .env("POLAKAPI_SOUND_PATH", &path);
        c
    };
    cmd.kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(30), cmd.status())
        .await
        .map_err(|_| "Sound playback timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not play sound".into())
    }
}

#[tauri::command]
pub async fn notification_run_command(
    command: String,
    title: String,
    body: String,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = crate::platform_command::tokio_command("/bin/sh")?;
        c.args(["-c", &command]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = crate::platform_command::tokio_command("cmd.exe")?;
        c.args(["/C", &command]);
        c
    };
    cmd.env("POLAKAPI_NOTIFICATION_TITLE", title)
        .env("POLAKAPI_NOTIFICATION_BODY", body)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(15), cmd.status())
        .await
        .map_err(|_| "Notification command timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Notification command exited with {status}"))
    }
}

#[tauri::command]
pub async fn notification_open_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = crate::platform_command::tokio_command("/usr/bin/open")?;
        c.arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = crate::platform_command::tokio_command("cmd.exe")?;
        c.args(["/C", "start", "", "ms-settings:notifications"]);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = crate::platform_command::tokio_command("gnome-control-center")?;
        c.arg("notifications");
        c
    };
    let status = cmd.status().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Open notification settings in your system preferences".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn subagent_tool_activity_does_not_reactivate_the_parent() {
        assert_eq!(
            hook_scope(
                "parent",
                &json!({"hook_event_name":"PostToolUse","agent_id":"child"})
            ),
            Some("parent:subagent:child".into())
        );
        assert_eq!(
            hook_scope("parent", &json!({"hook_event_name":"PostToolUse"})),
            Some("parent".into())
        );
        assert_eq!(
            hook_scope("parent", &json!({"hook_event_name":"SubagentStart"})),
            None
        );
    }

    #[test]
    fn consumes_recent_events_once_in_order_and_removes_expired_events() {
        let mut conn = connection(Path::new(":memory:")).unwrap();
        conn.execute("INSERT INTO notification_events (pty_id, kind, cli, created_at) VALUES ('a', 'started', 'claude', unixepoch()), ('a', 'finished', 'claude', unixepoch()), ('old', 'finished', 'claude', unixepoch() - 60)", []).unwrap();
        let events = take_events(&mut conn).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "started");
        assert_eq!(events[1].kind, "finished");
        assert!(take_events(&mut conn).unwrap().is_empty());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notification_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn classifies_only_relevant_hook_events() {
        assert_eq!(
            hook_kind(&json!({"hook_event_name":"Stop"})),
            Some("finished")
        );
        assert_eq!(
            hook_kind(
                &json!({"hook_event_name":"Notification", "notification_type":"permission_prompt"})
            ),
            Some("permission")
        );
        assert_eq!(
            hook_kind(
                &json!({"hook_event_name":"Notification", "notification_type":"idle_prompt"})
            ),
            Some("waiting")
        );
        assert_eq!(
            hook_kind(
                &json!({"hook_event_name":"Notification", "notification_type":"auth_success"})
            ),
            None
        );
    }
}

#[tauri::command]
pub fn notification_send(
    app: AppHandle,
    title: String,
    body: String,
    default_sound: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let sound = "NSUserNotificationDefaultSoundName";
    #[cfg(target_os = "windows")]
    let sound = "Default";
    #[cfg(target_os = "linux")]
    let sound = "message-new-instant";
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .sound(if default_sound { sound } else { "" })
        .show()
        .map_err(|e| e.to_string())
}
