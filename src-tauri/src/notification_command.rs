use std::{
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use tauri::State;

const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct NotificationCommandState(AtomicBool);

struct CommandSlot<'a>(&'a AtomicBool);

impl Drop for CommandSlot<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl NotificationCommandState {
    fn acquire(&self) -> Result<CommandSlot<'_>, String> {
        self.0
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "Another notification command is still running".to_string())?;
        Ok(CommandSlot(&self.0))
    }
}

#[tauri::command]
pub async fn notification_run_command(
    command: String,
    title: String,
    body: String,
    event: String,
    state: State<'_, NotificationCommandState>,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Ok(());
    }
    let process = shell_command(&command, &title, &body, &event)?;
    let _slot = state.acquire()?;
    run(process, TIMEOUT).await
}

fn shell_command(
    command: &str,
    title: &str,
    body: &str,
    event: &str,
) -> Result<tokio::process::Command, String> {
    if command.len() > 4096 || command.contains('\0') {
        return Err(
            "Notification commands must be at most 4096 bytes and contain no NUL characters".into(),
        );
    }
    if !matches!(
        event,
        "notification" | "permission" | "finished" | "waiting" | "bell" | "test"
    ) {
        return Err("Unknown notification event".into());
    }
    #[cfg(not(target_os = "windows"))]
    let mut process = {
        let mut process = crate::platform_command::tokio_command("/bin/sh")?;
        process.args(["-c", command]);
        process.process_group(0);
        process
    };
    #[cfg(target_os = "windows")]
    let mut process = {
        let mut process = crate::platform_command::tokio_command("powershell.exe")?;
        process.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        process
    };
    if let Some(home) = crate::platform_command::user_home_dir() {
        process.current_dir(home);
    }
    process
        .env("POLAKAPI_NOTIFICATION_TITLE", title)
        .env("POLAKAPI_NOTIFICATION_BODY", body)
        .env("POLAKAPI_NOTIFICATION_EVENT", event)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    Ok(process)
}

#[cfg(unix)]
struct ProcessGroup(u32);

#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // The child creates a dedicated process group; include its descendants in cleanup.
        unsafe { libc::kill(-(self.0 as i32), libc::SIGKILL) };
    }
}

async fn run(mut process: tokio::process::Command, timeout: Duration) -> Result<(), String> {
    let mut child = process
        .spawn()
        .map_err(|_| "Could not start notification command".to_string())?;
    #[cfg(unix)]
    let _group = ProcessGroup(child.id().ok_or("Notification command has no process ID")?);
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(match status.code() {
            Some(code) => format!("Notification command exited with code {code}"),
            None => "Notification command was terminated".into(),
        }),
        Ok(Err(_)) => Err("Could not wait for notification command".into()),
        Err(_) => {
            #[cfg(unix)]
            drop(_group);
            let _ = child.kill().await;
            Err("Notification command timed out after 10 seconds".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_commands_and_events() {
        assert!(shell_command(&"x".repeat(4097), "", "", "test").is_err());
        assert!(shell_command("echo\0", "", "", "test").is_err());
        assert!(shell_command("echo", "", "", "unknown").is_err());
    }

    #[test]
    fn prevents_overlapping_commands_and_releases_the_slot() {
        let state = NotificationCommandState::default();
        let slot = state.acquire().unwrap();
        assert!(state.acquire().is_err());
        drop(slot);
        assert!(state.acquire().is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn passes_metadata_as_data_without_shell_interpolation() {
        let directory = tempfile::tempdir().unwrap();
        let title = "$(touch injected) `touch injected` \"quoted\"";
        let body = "first line\nsecond line; touch injected";
        let mut process = shell_command(
            "printf '%s' \"$POLAKAPI_NOTIFICATION_TITLE\" > title; printf '%s' \"$POLAKAPI_NOTIFICATION_BODY\" > body; printf '%s' \"$POLAKAPI_NOTIFICATION_EVENT\" > event",
            title, body, "finished",
        ).unwrap();
        process.current_dir(directory.path());
        run(process, TIMEOUT).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.path().join("title")).unwrap(),
            title
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("body")).unwrap(),
            body
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("event")).unwrap(),
            "finished"
        );
        assert!(!directory.path().join("injected").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_failure_without_exposing_command_output() {
        let process = shell_command("echo private-output >&2; exit 7", "", "", "test").unwrap();
        assert_eq!(
            run(process, TIMEOUT).await.unwrap_err(),
            "Notification command exited with code 7"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_stops_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let mut process =
            shell_command("(sleep 0.4; touch survived) & wait", "", "", "test").unwrap();
        process.current_dir(directory.path());
        assert!(run(process, Duration::from_millis(100))
            .await
            .unwrap_err()
            .contains("timed out"));
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!directory.path().join("survived").exists());
    }
}
