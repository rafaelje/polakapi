use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::app_control::home::LaunchSpec;
use crate::loop_cli::parsers::{extract_codex_error, parse_claude_json};
use crate::platform_command;

// One headless agent turn: spawn the CLI in the agent home, write the prompt
// to stdin, wait for it to exit and pull the final answer out of its
// structured output. Dropping the future kills the process, which is how
// `/stop` and the timeout cancel a turn.

pub const TELEGRAM_MESSAGE_LIMIT: usize = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct TurnOutput {
    pub text: String,
    pub session: Option<String>,
}

pub async fn run(spec: &LaunchSpec, prompt: &str, timeout: Duration) -> Result<TurnOutput, String> {
    run_with_env(spec, prompt, timeout, &[]).await
}

pub async fn run_with_env(
    spec: &LaunchSpec,
    prompt: &str,
    timeout: Duration,
    env: &[(&str, &str)],
) -> Result<TurnOutput, String> {
    let mut command = platform_command::tokio_command(&spec.command)?;
    command
        .args(&spec.args)
        .envs(env.iter().copied())
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{} is not installed or not on PATH", spec.command),
        _ => format!("could not start {}: {e}", spec.command),
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("could not send the prompt to {}: {e}", spec.command))?;
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("timed out after {}s", timeout.as_secs()))?
        .map_err(|e| format!("{} failed: {e}", spec.command))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = match spec.cli.as_str() {
        "claude" => parse_claude(&stdout),
        "codex" => parse_codex(&stdout),
        other => Err(format!("{other} cannot run headless turns")),
    };
    match parsed {
        Ok(out) if !out.text.trim().is_empty() => Ok(out),
        Err(message) if !stdout.trim().is_empty() => Err(message),
        _ if !output.status.success() => Err(format!(
            "{} exited with {}: {}",
            spec.command,
            output.status,
            last_line(&String::from_utf8_lossy(&output.stderr))
        )),
        Ok(out) => Ok(TurnOutput {
            text: "(the agent finished without a reply)".to_string(),
            ..out
        }),
        Err(message) => Err(message),
    }
}

pub fn parse_claude(stdout: &str) -> Result<TurnOutput, String> {
    // With `--output-format json` claude prints one object; the last line is
    // taken in case anything else reached stdout first.
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .unwrap_or("");
    let result = parse_claude_json(line)?;
    if let Some(error) = result.error {
        return Err(error);
    }
    Ok(TurnOutput {
        text: result.text,
        session: result.session_id,
    })
}

pub fn parse_codex(stdout: &str) -> Result<TurnOutput, String> {
    let mut session = None;
    let mut text = String::new();
    let mut failure = None;
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                session = value
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            Some("item.completed")
                if value.pointer("/item/type").and_then(Value::as_str) == Some("agent_message") =>
            {
                if let Some(message) = value.pointer("/item/text").and_then(Value::as_str) {
                    text = message.to_string();
                }
            }
            Some("turn.failed") => {
                failure = value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            _ => {}
        }
    }
    if let Some(message) = failure.or_else(|| {
        text.is_empty()
            .then(|| extract_codex_error(stdout))
            .flatten()
    }) {
        return Err(format!("codex: {message}"));
    }
    Ok(TurnOutput { text, session })
}

fn last_line(text: &str) -> String {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no output")
        .chars()
        .take(400)
        .collect()
}

/// Splits an answer into Telegram-sized messages, preferring line breaks.
/// Telegram counts UTF-16 code units, so that is what is measured.
pub fn chunks(text: &str, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut current_len = 0;
    for line in text.split_inclusive('\n') {
        let line_len = line.encode_utf16().count();
        if current_len + line_len > limit && !current.is_empty() {
            out.push(std::mem::take(&mut current));
            current_len = 0;
        }
        if line_len <= limit {
            current.push_str(line);
            current_len += line_len;
            continue;
        }
        for ch in line.chars() {
            let width = ch.len_utf16();
            if current_len + width > limit {
                out.push(std::mem::take(&mut current));
                current_len = 0;
            }
            current.push(ch);
            current_len += width;
        }
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out.into_iter()
        .map(|chunk| chunk.trim_end().to_string())
        .filter(|chunk| !chunk.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_result_and_session() {
        let out = parse_claude(
            r#"{"type":"result","subtype":"success","is_error":false,"result":"2 projects","session_id":"abc"}"#,
        )
        .unwrap();
        assert_eq!(out.text, "2 projects");
        assert_eq!(out.session.as_deref(), Some("abc"));
        let failed = parse_claude(
            r#"{"type":"result","is_error":true,"result":"Credit balance is too low","session_id":"abc"}"#,
        );
        assert_eq!(failed.unwrap_err(), "Credit balance is too low");
    }

    #[test]
    fn codex_last_agent_message_and_thread() {
        let stdout = [
            r#"{"type":"thread.started","thread_id":"t-1"}"#,
            r#"{"type":"item.completed","item":{"id":"0","type":"reasoning","text":"thinking"}}"#,
            r#"{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"first"}}"#,
            r#"{"type":"item.completed","item":{"id":"2","type":"agent_message","text":"final"}}"#,
            r#"{"type":"turn.completed","usage":{}}"#,
        ]
        .join("\n");
        let out = parse_codex(&stdout).unwrap();
        assert_eq!(out.text, "final");
        assert_eq!(out.session.as_deref(), Some("t-1"));
        let failed = parse_codex(r#"{"type":"turn.failed","error":{"message":"quota"}}"#);
        assert_eq!(failed.unwrap_err(), "codex: quota");
    }

    #[test]
    fn chunks_respect_the_limit_and_line_breaks() {
        assert_eq!(chunks("hello\nworld", 4096), vec!["hello\nworld"]);
        assert_eq!(chunks("aaaa\nbbbb\ncc", 10), vec!["aaaa\nbbbb", "cc"]);
        let long = "x".repeat(25);
        let parts = chunks(&long, 10);
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|part| part.len() <= 10));
        let emoji = "😀".repeat(3);
        assert_eq!(chunks(&emoji, 4), vec!["😀😀", "😀"]);
        assert!(chunks("  \n ", 10).is_empty());
    }
}
