use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use super::child::{self, Limit};
use crate::platform_command;

// One shell command in a project directory, with stdout and stderr merged in
// the order they were written, the way a terminal shows them. Used by the
// `polakapi_run_command` tool and the Telegram bot's `/run`.

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OUTPUT_CHARS: usize = 20_000;
const KEPT_OUTPUT: Limit = Limit::tail(256 * 1024);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub command: String,
    pub cwd: String,
    /// `None` when the process was killed by a signal or the timeout.
    pub exit_code: Option<i32>,
    pub output: String,
    pub truncated: bool,
    pub timed_out: bool,
}

impl CommandOutput {
    /// `$ command`, the output, and the exit code when it is not zero.
    pub fn transcript(&self) -> String {
        let mut text = format!("$ {}\n{}", self.command, self.output.trim_end());
        if self.truncated {
            text.push_str("\n… (output truncated)");
        }
        if self.timed_out {
            text.push_str("\n[timed out]");
        } else if let Some(code) = self.exit_code.filter(|code| *code != 0) {
            text.push_str(&format!("\n[exit {code}]"));
        }
        text
    }
}

fn shell_command(command: &str) -> Result<tokio::process::Command, String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = platform_command::tokio_command("cmd")?;
        cmd.arg("/D").arg("/C").arg(format!("{command} 2>&1"));
        Ok(cmd)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // A login shell picks up the user's PATH even when polakapi was
        // started from a desktop launcher.
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|shell| !shell.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string());
        let mut cmd = platform_command::tokio_command(shell)?;
        cmd.arg("-lc").arg(format!("exec 2>&1\n{command}"));
        Ok(cmd)
    }
}

pub async fn run_shell(
    cwd: &str,
    command: &str,
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("the command is empty".to_string());
    }
    if !std::path::Path::new(cwd).is_dir() {
        return Err(format!("{cwd} is not a directory"));
    }
    let mut cmd = shell_command(command)?;
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Plain output: no pager waiting for a key, no color escapes.
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb");
    let output = child::spawn(&mut cmd)
        .map_err(|e| format!("could not start the shell: {e}"))?
        .wait(timeout, KEPT_OUTPUT, KEPT_OUTPUT)
        .await
        .map_err(|e| format!("command failed: {e}"))?;
    let mut raw = String::from_utf8_lossy(&output.stdout.bytes).into_owned();
    raw.push_str(&String::from_utf8_lossy(&output.stderr.bytes));
    let chars = raw.chars().count();
    let truncated = output.stdout.truncated || output.stderr.truncated || chars > MAX_OUTPUT_CHARS;
    let output_text: String = if chars > MAX_OUTPUT_CHARS {
        raw.chars().skip(chars - MAX_OUTPUT_CHARS).collect()
    } else {
        raw
    };
    Ok(CommandOutput {
        command: command.to_string(),
        cwd: cwd.to_string(),
        exit_code: output.status.and_then(|status| status.code()),
        output: output_text,
        truncated,
        timed_out: output.status.is_none(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    #[serde(flatten)]
    pub output: CommandOutput,
    pub transcript: String,
}

#[tauri::command]
pub async fn app_run_command(cwd: String, command: String) -> Result<RunResult, String> {
    let output = run_shell(&cwd, &command, DEFAULT_TIMEOUT).await?;
    let transcript = output.transcript();
    Ok(RunResult { output, transcript })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_looks_like_a_terminal() {
        let mut out = CommandOutput {
            command: "git status".into(),
            cwd: "/p".into(),
            exit_code: Some(0),
            output: "On branch main\nnothing to commit\n".into(),
            truncated: false,
            timed_out: false,
        };
        assert_eq!(
            out.transcript(),
            "$ git status\nOn branch main\nnothing to commit"
        );
        out.exit_code = Some(128);
        assert!(out.transcript().ends_with("\n[exit 128]"));
        out.timed_out = true;
        assert!(out.transcript().ends_with("\n[timed out]"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn merges_stderr_and_reports_the_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let out = run_shell(
            &dir.path().to_string_lossy(),
            "echo out; echo err 1>&2; exit 3",
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(out.output, "out\nerr\n");
        assert_eq!(out.exit_code, Some(3));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn times_out() {
        let dir = tempfile::tempdir().unwrap();
        let out = run_shell(
            &dir.path().to_string_lossy(),
            "sleep 5",
            Duration::from_millis(200),
        )
        .await
        .unwrap();
        assert!(out.timed_out);
        assert_eq!(out.exit_code, None);
    }

    #[tokio::test]
    async fn rejects_empty_commands_and_missing_directories() {
        assert!(run_shell("/", "  ", DEFAULT_TIMEOUT).await.is_err());
        assert!(run_shell("/definitely/not/here", "ls", DEFAULT_TIMEOUT)
            .await
            .is_err());
    }
}
