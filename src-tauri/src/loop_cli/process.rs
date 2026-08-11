use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Runs `cmd` in `cwd` capturing stdout/stderr, with a hard timeout that
/// actually kills the subprocess on expiry.
///
/// Implementation note: `tokio::time::timeout(.., child.wait_with_output())`
/// drops the wait future when the timeout fires. We set `kill_on_drop(true)`
/// on the `Command` so dropping the `Child` (which the wait future owns)
/// sends `SIGKILL` synchronously to the subprocess. Without this the
/// advertised timeout would be a lie — the future returns `Err` but the CLI
/// keeps running in the background.
///
/// Maps "binary not found" (`ErrorKind::NotFound`) to a human-readable error
/// that the frontend uses to suggest the user install the CLI.
pub(super) async fn run_command(
    mut cmd: Command,
    cwd: &str,
    cli_name: &str,
    effort: Option<&str>,
    timeout_dur: Duration,
) -> Result<std::process::Output, String> {
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let started_at = std::time::Instant::now();

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let elapsed_ms = started_at.elapsed().as_millis();
            let io_result: std::io::Result<std::process::Output> =
                Err(std::io::Error::new(e.kind(), e.to_string()));
            log_cli_invocation(cli_name, cwd, effort, elapsed_ms, &io_result);
            return Err(match e.kind() {
                std::io::ErrorKind::NotFound => {
                    format!("CLI '{cli_name}' not found in PATH. Install it and reopen the app.")
                }
                _ => format!("error invoking {cli_name}: {e}"),
            });
        }
    };

    // Section 10.5 — optional invocation log. We append to a file in the
    // system temp dir for post-mortem debugging. Failing here must not break
    // the CLI execution — all logger IO errors are ignored.
    match timeout(timeout_dur, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let elapsed_ms = started_at.elapsed().as_millis();
            let io_result: std::io::Result<std::process::Output> = Ok(output);
            log_cli_invocation(cli_name, cwd, effort, elapsed_ms, &io_result);
            // io_result is Ok, so unwrap is safe.
            io_result.map_err(|e| format!("error waiting on {cli_name}: {e}"))
        }
        Ok(Err(e)) => {
            let elapsed_ms = started_at.elapsed().as_millis();
            let io_result: std::io::Result<std::process::Output> =
                Err(std::io::Error::new(e.kind(), e.to_string()));
            log_cli_invocation(cli_name, cwd, effort, elapsed_ms, &io_result);
            Err(format!("error waiting on {cli_name}: {e}"))
        }
        Err(_elapsed) => {
            // The wait future is dropped here; `kill_on_drop(true)` sends
            // SIGKILL synchronously and tokio reaps the child on a background
            // task. The subprocess is gone before we return.
            let elapsed_ms = started_at.elapsed().as_millis();
            let io_result: std::io::Result<std::process::Output> = Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("timeout after {}s", timeout_dur.as_secs()),
            ));
            log_cli_invocation(cli_name, cwd, effort, elapsed_ms, &io_result);
            Err(format!(
                "timeout after {}s invoking {cli_name}",
                timeout_dur.as_secs()
            ))
        }
    }
}

/// Path to the CLI invocation log. Lives at `<temp>/polakapi-loop-cli.log` to
/// keep it predictable and without requiring the AppHandle of the Tauri
/// command.
fn cli_log_path() -> PathBuf {
    std::env::temp_dir().join("polakapi-loop-cli.log")
}

/// Append a single line to the invocation log. Soft-fail: any IO error is
/// ignored — the logger is auxiliary and must not break the run flow.
fn log_cli_invocation(
    cli_name: &str,
    cwd: &str,
    effort: Option<&str>,
    elapsed_ms: u128,
    result: &std::io::Result<std::process::Output>,
) {
    let path = cli_log_path();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let effort_field = effort.unwrap_or("-");

    let line = match result {
        Ok(out) => format!(
            "[{now}] cli={cli_name} cwd={cwd} effort={effort_field} elapsed_ms={elapsed_ms} exit={} stdout_bytes={} stderr_bytes={}\n",
            out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string()),
            out.stdout.len(),
            out.stderr.len(),
        ),
        Err(e) => format!(
            "[{now}] cli={cli_name} cwd={cwd} effort={effort_field} elapsed_ms={elapsed_ms} error={e}\n"
        ),
    };

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}
