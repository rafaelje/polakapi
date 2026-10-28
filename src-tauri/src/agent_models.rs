//! Lists the models each agent CLI reports itself, so model pickers never
//! carry a hardcoded catalogue that goes stale.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use crate::platform_command;

const LIST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

type Parser = fn(&str) -> Result<Vec<ModelOption>, String>;

#[tauri::command]
pub async fn agent_cli_models(cli: String) -> Result<Vec<ModelOption>, String> {
    let (program, args, parse): (&str, &[&str], Parser) = match cli.as_str() {
        "claude" => ("claude", &["--help"], parse_claude_help),
        "codex" => ("codex", &["debug", "models"], parse_codex_catalog),
        "cursor" => ("cursor-agent", &["models"], parse_cursor_models),
        "opencode" => ("opencode", &["models"], parse_opencode_models),
        _ => return Err(format!("unknown agent CLI: {cli}")),
    };
    let mut command = platform_command::tokio_command(program)?;
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(LIST_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("{program} took too long to list its models"))?
        .map_err(|error| format!("could not run {program}: {error}"))?;
    if !output.status.success() {
        let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
        return Err(format!(
            "{program} {} failed: {}",
            args.join(" "),
            stderr.trim()
        ));
    }
    parse(&strip_ansi(&String::from_utf8_lossy(&output.stdout)))
}

/// Claude Code has no model listing command; its `--help` names the aliases
/// `--model` accepts, which always resolve to the latest model of each family.
fn parse_claude_help(help: &str) -> Result<Vec<ModelOption>, String> {
    let mut lines = help
        .lines()
        .skip_while(|line| !line.trim_start().starts_with("--model "));
    let Some(first) = lines.next() else {
        return Err("claude --help does not describe --model".into());
    };
    let mut block = first.to_string();
    for line in lines.take_while(|line| !line.trim_start().starts_with('-')) {
        block.push(' ');
        block.push_str(line.trim());
    }
    let models: Vec<ModelOption> = block
        .split('\'')
        .skip(1)
        .step_by(2)
        .filter(|alias| is_model_id(alias))
        .map(|alias| option(alias, alias))
        .collect();
    non_empty(models, "claude")
}

fn parse_codex_catalog(json: &str) -> Result<Vec<ModelOption>, String> {
    let catalog: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| format!("codex debug models is not JSON: {error}"))?;
    let mut listed: Vec<(i64, ModelOption)> = catalog
        .get("models")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| model.get("visibility").and_then(serde_json::Value::as_str) == Some("list"))
        .filter_map(|model| {
            let slug = model.get("slug")?.as_str()?;
            let label = model
                .get("display_name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(slug);
            let priority = model
                .get("priority")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(i64::MAX);
            Some((priority, option(slug, label)))
        })
        .collect();
    listed.sort_by_key(|(priority, _)| *priority);
    non_empty(
        listed.into_iter().map(|(_, model)| model).collect(),
        "codex",
    )
}

/// `cursor-agent models` prints one `<id> - <label>` line per model.
fn parse_cursor_models(text: &str) -> Result<Vec<ModelOption>, String> {
    let models = text
        .lines()
        .filter_map(|line| line.trim().split_once(" - "))
        .filter(|(id, _)| is_model_id(id))
        .map(|(id, label)| option(id, label.trim()))
        .collect();
    non_empty(models, "cursor-agent")
}

/// `opencode models` prints one `<provider>/<model>` id per line.
fn parse_opencode_models(text: &str) -> Result<Vec<ModelOption>, String> {
    let models = text
        .lines()
        .map(str::trim)
        .filter(|line| line.contains('/') && is_model_id(line))
        .map(|id| option(id, id))
        .collect();
    non_empty(models, "opencode")
}

fn is_model_id(value: &str) -> bool {
    !value.is_empty() && !value.contains(char::is_whitespace)
}

fn option(id: &str, label: &str) -> ModelOption {
    ModelOption {
        id: id.to_string(),
        label: label.to_string(),
    }
}

fn non_empty(models: Vec<ModelOption>, program: &str) -> Result<Vec<ModelOption>, String> {
    if models.is_empty() {
        Err(format!("{program} reported no models"))
    } else {
        Ok(models)
    }
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.next() == Some('[') {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
